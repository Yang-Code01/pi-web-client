/**
 * 壳 ↔ 脑 的控制通道：命名管道（Windows）或 unix socket，一行一帧 NDJSON。
 *
 * 为什么不是 TCP 回环口：控制通道里会走「spawn 一个会话进程」「往它的 stdin 写一帧」这类
 * 请求。开在随机端口上，同一台机器的任何进程都能连上来当脑，等于把会话的写入口交给别人；
 * 命名管道/unix socket 天生带权限边界，也不需要抢端口。
 *
 * 分帧复用了 broker 里那套按字节缓冲的实现：`data` 事件切在哪儿都可能，整行才解码。
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { LineSplitter, MAX_BUFFER_BYTES } from "./broker.ts";

/**
 * 控制通道的单帧上限。`attached` 一帧里装着未确认窗口（原始最多 `MAX_BUFFER_BYTES`，嵌在 JSON
 * 字符串里还要再转义一遍）和没答的问卷；跟子进程输出共用 8 MiB 的话，窗口快满时这一帧会被
 * 当残行整段丢掉，脑等满 15 秒报「壳 attached 超时」。给它留足余量。
 */
export const MAX_CONTROL_FRAME_BYTES = 8 * MAX_BUFFER_BYTES;

/** 协议版本。壳与脑对不上就拒绝握手（整组重启是唯一出路，见 D407）。 */
export const CONTROL_PROTO = 1;

/**
 * 控制通道的一帧：`t` 是消息类型，其余字段随类型变化（hello / spawn / attach / line…）。
 * 具体字段由两端的 handler 按 `t` 解释。这里至少把「必须是带 t 的对象」钉在边界上，
 * 不让 JSON.parse 出来的任意值直接流进业务代码。
 */
export interface ControlMessage {
  t: string;
  [key: string]: unknown;
}

/**
 * Unix 上控制套接字所在目录必须是当前用户独占的：放在共享的 tmpdir 根下，别人可以先占住
 * 路径（拒绝服务），也能直接连上来冒充脑。Windows 的命名管道自带 ACL，不需要这一层。
 */
function privateDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `pi-web-${uid}`);
}

function ensurePrivateDir(dir: string): void {
  // 只整理我们自己的目录；调用方传了别的路径就原样交回给系统，不去改别人的权限。
  if (path.resolve(dir) !== path.resolve(privateDir())) return;
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (!st) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    st = fs.lstatSync(dir);
  }
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`控制通道目录不是普通目录：${dir}`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`控制通道目录不属于当前用户：${dir}`);
  }
  fs.chmodSync(dir, 0o700);
}

export function controlPath(port: number): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\pi-web-brain-${port}`
    : path.join(privateDir(), `brain-${port}.sock`);
}

/** 一根通道：发一帧，或收一帧。两边对称，壳和脑共用。 */
export class ControlConn {
  readonly socket: net.Socket;
  private readonly splitter = new LineSplitter(MAX_CONTROL_FRAME_BYTES);
  private readonly msgListeners: ((msg: ControlMessage) => void)[] = [];
  private readonly closeListeners: (() => void)[] = [];
  private closed = false;

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      if (this.closed) return;
      this.closed = true;
      for (const cb of this.closeListeners) cb();
    });
  }

  private onData(chunk: Buffer): void {
    const { lines } = this.splitter.push(chunk);
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      if (typeof (parsed as { t?: unknown }).t !== "string") continue;
      const msg = parsed as ControlMessage;
      for (const cb of this.msgListeners) cb(msg);
    }
  }

  get alive(): boolean {
    return !this.closed && !this.socket.destroyed && this.socket.writable;
  }

  send(msg: Record<string, unknown>): void {
    if (!this.alive) return;
    try {
      this.socket.write(JSON.stringify(msg) + "\n");
    } catch {
      /* 对端没了：由 close 走正常收尾 */
    }
  }

  onMessage(cb: (msg: ControlMessage) => void): void {
    this.msgListeners.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeListeners.push(cb);
  }

  close(): void {
    this.socket.end();
  }
}

/** 探测现有控制口是不是还有壳在听。连得上就是活的；连不上才是上次留下的死文件。 */
function controlInUse(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    let done = false;
    let timer: NodeJS.Timeout;
    const finish = (inUse: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(inUse);
    };
    // 探测超时按「有人在听」处理：宁可拒绝启动，也不要删掉一个可能还活着的壳的控制口。
    timer = setTimeout(() => finish(true), 500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** 壳这一侧：监听控制通道，每来一个脑给一根 ControlConn。 */
export async function serveControl(socketPath: string, onConn: (conn: ControlConn) => void): Promise<net.Server> {
  const unix = process.platform !== "win32";
  if (unix) {
    ensurePrivateDir(path.dirname(socketPath));
    // 上一轮被 kill 时 unix socket 文件会留在盘上；不删就 EADDRINUSE。
    // 但先确认它不是另一个正在运行的壳的：第二个壳删掉它，旧壳就再也接不到换脑/重连。
    if (fs.existsSync(socketPath)) {
      if (await controlInUse(socketPath)) {
        throw new Error(`控制通道已被另一个壳占用：${socketPath}`);
      }
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* 删不掉就让 listen 报错，别在这里吞成「起不来但没原因」 */
      }
    }
  }
  const server = net.createServer((socket) => onConn(new ControlConn(socket)));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      if (unix && path.resolve(path.dirname(socketPath)) === path.resolve(privateDir())) {
        // 目录 0700 已经挡住别的用户；socket 再收紧到 0600，别依赖 umask。
        try {
          fs.chmodSync(socketPath, 0o600);
        } catch {
          /* 文件系统不支持 chmod 时目录权限仍然是边界 */
        }
      }
      resolve(server);
    });
  });
}

/** 脑这一侧：连上去拿一根 ControlConn；连不上就 reject（调用方负责退出）。 */
export function connectControl(socketPath: string): Promise<ControlConn> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const conn = new ControlConn(socket);
    let opened = false;
    socket.once("connect", () => {
      opened = true;
      resolve(conn);
    });
    socket.once("error", (err) => {
      if (!opened) reject(err);
    });
  });
}
