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
import { LineSplitter } from "./broker.ts";

/** 协议版本。壳与脑对不上就拒绝握手（整组重启是唯一出路，见 D385）。 */
export const CONTROL_PROTO = 1;

export function controlPath(port: number): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\pi-web-brain-${port}`
    : path.join(os.tmpdir(), `pi-web-brain-${port}.sock`);
}

/** 一根通道：发一帧，或收一帧。两边对称，壳和脑共用。 */
export class ControlConn {
  readonly socket: net.Socket;
  private readonly splitter = new LineSplitter();
  private readonly msgListeners: ((msg: any) => void)[] = [];
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
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
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

  onMessage(cb: (msg: any) => void): void {
    this.msgListeners.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeListeners.push(cb);
  }

  close(): void {
    this.socket.end();
  }
}

/** 壳这一侧：监听控制通道，每来一个脑给一根 ControlConn。 */
export function serveControl(socketPath: string, onConn: (conn: ControlConn) => void): Promise<net.Server> {
  if (process.platform !== "win32") {
    // 上一轮被 kill 时 unix socket 文件会留在盘上；不删就 EADDRINUSE。
    try {
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    } catch {
      /* 删不掉就让 listen 报错，别在这里吞成「起不来但没原因」 */
    }
  }
  const server = net.createServer((socket) => onConn(new ControlConn(socket)));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(server));
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
