/**
 * 壳（host）：公网口的唯一持有者，也是所有 pi 子进程的父进程。
 *
 * 为什么要有这一层（D385）：热部署过去是「杀掉整个桥 → 起新桥」，于是 pi 子进程跟着死，
 * 正在跑的那一轮就断了。壳把「端口 + 管道」从会换代的代码里拿出来，换代只换脑（index.js），
 * 管道和 pid 不动，页面重连后接着看那一轮。
 *
 * 这里刻意只做四件事：转发、盯住脑、替脑 spawn/写 stdin、记账。pi 的协议归脑解释。
 *
 * 逃生口：`PI_HOST_DISABLE=1` 时 index.js 按老样子自己听公网口（不经过壳、不跨代）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { statePath } from "./paths.ts";
import { removePidFile, writePidFile } from "./pidfile.ts";
import { Broker } from "./host/broker.ts";
import { Children, type SpawnSpec } from "./host/children.ts";
import { BrainProxy } from "./host/proxy.ts";
import { CONTROL_PROTO, ControlConn, controlPath, serveControl } from "./host/control.ts";
import { UsageLedger } from "./host/ledger.ts";

const VERSION = "0.1.0";
/** 新脑 ready 之后先观察这么久再切（用户选了「切完老脑立刻退」，所以观察必须在切换之前）。 */
const OBSERVE_MS = Number(process.env.PI_HOST_OBSERVE_MS ?? 5000) || 5000;
/** 脑崩了到重拉之间的间隔。 */
const RESPAWN_MS = 1000;
/** 脑连接不上 / 不 hello 的超时。 */
const HELLO_MS = 30_000;

interface Brain {
  id: string;
  conn: ControlConn;
  pid: number;
  buildId: string;
  internalPort: number;
  ready: boolean;
  /** 这个脑知道自己该解释哪些会话（spawn 或 attach 过）。其余的行走壳的未确认缓冲。 */
  sessions: Set<string>;
  attachedAt: number;
}

interface DeployState {
  phase: "idle" | "running" | "observing" | "switched" | "failed" | "needs-group-restart";
  at: number;
  ok?: boolean;
  reason?: string;
  buildId?: string;
  /** 新脑 pid，面板爱显示就显示 */
  brainPid?: number;
}

function log(line: string): void {
  console.log(`[host ${new Date().toISOString().slice(11, 19)}] ${line}`);
}

function readPort(): number {
  const env = Number(process.env.PI_WEB_PORT);
  if (Number.isInteger(env) && env > 0) return env;
  try {
    const cfg = JSON.parse(fs.readFileSync(statePath("config.json"), "utf8")) as { port?: number };
    if (Number.isInteger(cfg.port) && cfg.port! > 0) return cfg.port!;
  } catch {
    /* 没有配置文件就走默认端口 */
  }
  return 7864;
}

/**
 * 监听地址：跟桥自己当年的默认一致（回环）。
 *
 * 壳是公网口的持有者，如果它自己把 0.0.0.0 写死，等于在最常见的默认路径上把服务
 * 从「只有本机能连」偷变成「整个局域网能连」，口令就暴露给扫描器了。
 */
function readHost(): string {
  const env = process.env.PI_WEB_HOST;
  if (env) return env;
  try {
    const cfg = JSON.parse(fs.readFileSync(statePath("config.json"), "utf8")) as { host?: string };
    if (cfg.host) return cfg.host;
  } catch {
    /* 没有配置文件就走回环 */
  }
  return "127.0.0.1";
}

function repoRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..");
}

/** 壳自己的构建指纹：换脑之后再验一遍，壳变了就只能整组重启（用户选定的边界）。 */
function selfFingerprint(): string {
  const dir = path.join(repoRoot(), "bridge", "dist");
  const hash = crypto.createHash("sha256");
  const walk = (d: string): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js") && (d.endsWith("host") || p === path.join(dir, "host.js"))) {
        try {
          hash.update(fs.readFileSync(p));
        } catch {
          /* 读不到就不进指纹 */
        }
      }
    }
  };
  walk(dir);
  return hash.digest("hex").slice(0, 12);
}

function buildIdOnDisk(): string {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(repoRoot(), "bridge", "dist", "build-id.json"), "utf8"));
    return String(raw.id ?? "");
  } catch {
    return "";
  }
}

let seqId = 0;
function newBrainId(): string {
  return `b${++seqId}-${process.pid}`;
}

async function main(): Promise<void> {
  const port = readPort();
  const listenHost = readHost();
  const root = repoRoot();
  // e2e 用假脑顶替真脑；平时不设这个变量。
  const brainEntry = process.env.PI_HOST_BRAIN || path.join(root, "bridge", "dist", "index.js");
  if (!fs.existsSync(brainEntry)) {
    console.error(`[host] 找不到 ${brainEntry} —— 先 npm run build:bridge`);
    process.exit(1);
  }

  const broker = new Broker();
  // 用量账本：跨换代、跨整组重启都活着（D385）。开壳时把上次的账读回来。
  const ledger = new UsageLedger(statePath("host", "usage.jsonl"));
  if (ledger.size) log(`账本里已有 ${ledger.size} 个会话的用量`);
  const sessions = new Map<string, SpawnSpec>();
  /** 每个会话还没被回答的 extension_ui_request（问卷 / 审批）：换脑时页面上的表单不能凭空消失。 */
  const pendingUi = new Map<string, Map<string, string>>();
  /** 每个会话这一轮还在不在跑（换脑后脑要靠它把 running 恢复出来）。 */
  const turns = new Map<string, boolean>();
  const snapshotSessions = () => broker.sessions().map((id) => ({ id, turnActive: Boolean(turns.get(id)) }));
  let brain: Brain | null = null;
  let starting: Brain | null = null;
  /** 刚为换脑拉起了一代、还没握手：它的 hello 要当候选，而不是「多余的脑」。 */
  let expectingSwap = false;
  let hostBuildId = selfFingerprint();
  let deploy: DeployState = { phase: "idle", at: 0 };
  let shuttingDown = false;

  /** 记下一条还没答的 extension_ui_request（按 id 去重；同一条被重放多少次都只有一份）。 */
  function rememberUi(sessionId: string, line: string): void {
    try {
      const msg = JSON.parse(line);
      const id = String(msg?.id ?? "");
      if (!id) return;
      let box = pendingUi.get(sessionId);
      if (!box) {
        box = new Map();
        pendingUi.set(sessionId, box);
      }
      box.set(id, line);
    } catch {
      /* 不是 JSON 就不是我们的活 */
    }
  }

  /** 脑把回答写回 stdin 了：这条不用再重放。 */
  function forgetAnsweredUi(sessionId: string, data: string): void {
    const box = pendingUi.get(sessionId);
    if (!box?.size || !data.includes('"extension_ui_response"')) return;
    for (const raw of data.split("\n")) {
      if (!raw.includes('"extension_ui_response"')) continue;
      try {
        box.delete(String(JSON.parse(raw)?.id ?? ""));
      } catch {
        /* ignore */
      }
    }
  }

  const children = new Children(broker, {
    line(sessionId, seq, line) {
      // 这一轮还在不在跑，只有壳看得见（脑换代时它的状态就丢了）。就按 pi 自己的事件记：
      // agent_start 开一轮，agent_end 收一轮 —— 新脑接管时靠这个把「思考中」恢复出来。
      if (line.includes('"agent_start"')) turns.set(sessionId, true);
      else if (line.includes('"agent_end"')) turns.set(sessionId, false);
      // 还没答的问卷 / 审批留在壳里：换脑后由新脑重放，否则页面那张表单就哑了（D385）。
      if (line.includes('"extension_ui_request"')) rememberUi(sessionId, line);
      const target = brain && brain.sessions.has(sessionId) ? brain : null;
      // 没有脑（或新脑还不认识这个会话）时，行留在 broker 的未确认窗口里：
      // 下一个 attach 的脑会从 pending 里原样拿走，不丢也不重。
      target?.conn.send({ t: "line", sessionId, seq, line });
    },
    stderr(sessionId, text) {
      if (brain?.sessions.has(sessionId)) brain.conn.send({ t: "stderr", sessionId, text });
    },
    exit(sessionId, code, signal) {
      log(`会话 ${sessionId} 的子进程退出（code=${code} signal=${signal}）`);
      sessions.delete(sessionId);
      turns.delete(sessionId);
      pendingUi.delete(sessionId);
      // 子进程是壳的，退出只有壳看得到；认领这个会话的脑要收到一声，否则它会一直以为还在跑。
      if (brain && brain.sessions.has(sessionId)) brain.conn.send({ t: "child-exit", sessionId, code, signal });
    },
  });

  // ---------------------------------------------------------------- 公共口
  const proxy = new BrainProxy({ targetPort: () => (brain?.ready ? brain.internalPort : null), log });

  const state = () => ({
    ok: true,
    version: VERSION,
    buildId: hostBuildId,
    pid: process.pid,
    uptime: Math.round(process.uptime()),
    brain: brain ? { pid: brain.pid, buildId: brain.buildId, ready: brain.ready } : null,
    deploy,
    sessions: broker.sessions().map((id) => {
      const p = broker.pending(id);
      return {
        id,
        pid: children.pid(id),
        turnActive: Boolean(turns.get(id)),
        owner: broker.ownerOf(id) === brain?.id ? "current" : broker.ownerOf(id) ? "other" : null,
        fromSeq: p.fromSeq,
        toSeq: p.toSeq,
        lastWritten: broker.lastWritten(id),
        buffered: broker.bufferedBytes(id),
        overflowed: p.overflowed,
      };
    }),
  });

  const isTunnelish = (req: http.IncomingMessage): boolean =>
    Boolean(req.headers["cf-connecting-ip"] ?? req.headers["cf-ray"] ?? req.headers["x-forwarded-for"]);

  const hostOnly = (req: http.IncomingMessage): boolean =>
    /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(req.socket.remoteAddress ?? "") && !isTunnelish(req);

  /**
   * 只信「自己页面发出来的」POST。
   *
   * 回环判断挡不住浏览器：别的网站一行 `<img src="http://127.0.0.1:7864/api/host/stop">`
   * 就是从 127.0.0.1 发出的。`Sec-Fetch-Site` / `Origin` 是浏览器自己写的，页面改不了。
   */
  const sameOrigin = (req: http.IncomingMessage): boolean => {
    const site = String(req.headers["sec-fetch-site"] ?? "");
    if (site && site !== "same-origin" && site !== "none") return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const u = new URL(String(origin));
      return u.host === (req.headers.host ?? "") || u.hostname === "127.0.0.1" || u.hostname === "localhost";
    } catch {
      return false;
    }
  };

  const publicServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/healthz") {
      const s = state();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ...s, pid: hostOnly(req) ? process.pid : undefined, public: isTunnelish(req) }));
      return;
    }
    if (url.pathname === "/api/host/status") {
      if (!hostOnly(req)) return void json(res, 403, { ok: false, code: "non-loopback" });
      return void json(res, 200, state());
    }
    if (url.pathname === "/api/host/stop") {
      if (!hostOnly(req)) return void json(res, 403, { ok: false, code: "non-loopback" });
      if (req.method !== "POST") return void json(res, 405, { ok: false, code: "post-only" });
      if (!sameOrigin(req)) return void json(res, 403, { ok: false, code: "cross-origin" });
      void stop("all");
      return void json(res, 200, { ok: true, stopping: true });
    }
    if (url.pathname === "/api/host/deploy" && req.method === "POST") {
      if (!hostOnly(req)) return void json(res, 403, { ok: false, code: "non-loopback" });
      if (!sameOrigin(req)) return void json(res, 403, { ok: false, code: "cross-origin" });
      const action = url.searchParams.get("action") ?? "run";
      if (action === "run") void runDeploy(url.searchParams.get("branch") ?? undefined, url.searchParams.get("stash") === "1");
      return void json(res, 200, { ok: true, accepted: true, deploy });
    }
    proxy.handle(req, res);
  });
  publicServer.on("upgrade", (req, socket, head) => proxy.handleUpgrade(req, socket, head));

  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  // ---------------------------------------------------------------- 控制通道
  const sock = controlPath(port);
  const control = await serveControl(sock, (conn) => onBrainConn(conn));

  function onBrainConn(conn: ControlConn): void {
    let candidate: Brain | null = null;
    conn.onClose(() => {
      if (shuttingDown) return;
      if (candidate && brain === candidate) return brainLost(candidate, "脑退出了");
      if (candidate && starting === candidate) {
        starting = null;
        failDeploy(candidate, "新脑在握手/重放阶段退出");
        return;
      }
      log(`控制通道断开（未完成握手的连接）`);
    });
    conn.onMessage((msg: any) => {
      if (!msg || typeof msg.t !== "string") return;
      if (msg.t === "hello") {
        candidate = onHello(conn, msg);
        return;
      }
      if (!candidate) return;
      onBrainMessage(candidate, msg);
    });
  }

  function onHello(conn: ControlConn, msg: any): Brain {
    const next: Brain = {
      id: newBrainId(),
      conn,
      pid: Number(msg.pid) || 0,
      buildId: String(msg.buildId ?? ""),
      internalPort: Number(msg.internalPort) || 0,
      ready: false,
      sessions: new Set(),
      attachedAt: Date.now(),
    };
    if (msg.proto !== CONTROL_PROTO) {
      log(`拒绝握手：proto ${msg.proto} ≠ ${CONTROL_PROTO}`);
      conn.send({ t: "reject", reason: `proto-mismatch:${CONTROL_PROTO}` });
      conn.close();
      return next;
    }
    if (!brain) {
      brain = next;
      conn.send({ t: "welcome", proto: CONTROL_PROTO, peerHeader: "x-pi-peer", hostBuildId, publicPort: port });
      conn.send({ t: "snapshot", hostBuildId, publicPort: port, buildId: next.buildId, sessions: snapshotSessions() });
      conn.send({ t: "usage-snapshot", sessions: ledger.snapshot() });
      log(`脑 ${next.pid} 连上（首个，buildId ${next.buildId || "?"}）`);
      return next;
    }
    if (expectingSwap && (!swapPid || swapPid === next.pid)) {
      // 上一次拉起的候选脑还没切就被这次顶掉了（重试 / 双开）：把旧连接关掉，别让它挂在壳上。
      if (starting && starting !== next && starting.conn.alive) starting.conn.close();
      starting = next;
      expectingSwap = false;
      log(`新脑 ${next.pid} 连上，等待 ready（buildId ${next.buildId || "?"}）`);
      conn.send({
        t: "welcome",
        proto: CONTROL_PROTO,
        peerHeader: "x-pi-peer",
        hostBuildId,
        publicPort: port,
        swap: true,
      });
      conn.send({ t: "snapshot", hostBuildId, publicPort: port, buildId: next.buildId, sessions: snapshotSessions() });
      conn.send({ t: "usage-snapshot", sessions: ledger.snapshot() });
      return next;
    }
    // 既不是首个、也没有人在等它：多出来的脑，让它退。
    log(`多余的脑 ${next.pid}，拒绝`);
    conn.send({ t: "reject", reason: "unexpected" });
    conn.close();
    return next;
  }

  function onBrainMessage(b: Brain, msg: any): void {
    switch (msg.t) {
      case "ready": {
        b.ready = true;
        if (brain === b) {
          log(`脑 ${b.pid} 就绪`);
          proxy.release();
          return;
        }
        if (starting === b) {
          observeThenSwitch(b);
          return;
        }
        return;
      }
      case "spawn": {
        const spec: SpawnSpec = {
          sessionId: String(msg.sessionId),
          argv: Array.isArray(msg.argv) ? msg.argv.map(String) : [],
          cwd: String(msg.cwd ?? process.cwd()),
          env: msg.env && typeof msg.env === "object" ? (msg.env as Record<string, string>) : {},
        };
        try {
          const pid = children.spawn(spec);
          sessions.set(spec.sessionId, spec);
          b.sessions.add(spec.sessionId);
          broker.setOwner(spec.sessionId, b.id);
          b.conn.send({ t: "spawned", rid: msg.rid, pid });
        } catch (err) {
          b.conn.send({ t: "spawn-failed", rid: msg.rid, reason: String((err as Error).message ?? err) });
        }
        return;
      }
      case "attach": {
        const sessionId = String(msg.sessionId);
        if (!children.has(sessionId)) {
          b.conn.send({ t: "attach-failed", rid: msg.rid, reason: "no-child" });
          return;
        }
        b.sessions.add(sessionId);
        broker.setOwner(sessionId, b.id);
        const p = broker.pending(sessionId);
        b.conn.send({
          t: "attached",
          rid: msg.rid,
          pid: children.pid(sessionId),
          pending: p,
          lastWritten: broker.lastWritten(sessionId),
          // 换脑窗口里子进程若退出 / 吐过错误，通知发给的是老脑；新脑得知道。
          lastExit: children.lastExit(sessionId),
          lastStderr: children.lastStderr(sessionId),
          // 换脑前还挂着的问卷：新脑拿去重放，页面那张表单接着能答。
          pendingUi: [...(pendingUi.get(sessionId)?.values() ?? [])],
        });
        return;
      }
      case "stdin": {
        const sessionId = String(msg.sessionId);
        const seq = broker.enqueueWrite(sessionId, b.id, String(msg.data ?? ""));
        if (seq === null) {
          b.conn.send({ t: "stale-owner", sessionId });
          return;
        }
        if (!children.write(sessionId, String(msg.data ?? ""))) {
          b.conn.send({ t: "write-failed", sessionId, seq });
          return;
        }
        forgetAnsweredUi(sessionId, String(msg.data ?? ""));
        broker.written(sessionId, seq);
        b.conn.send({ t: "written", sessionId, seq });
        return;
      }
      case "ack": {
        broker.ack(String(msg.sessionId), Number(msg.seq));
        return;
      }
      case "kill": {
        children.kill(String(msg.sessionId), msg.mode === "now");
        return;
      }
      case "usage": {
        const usage = msg.usage && typeof msg.usage === "object" ? (msg.usage as Record<string, unknown>) : null;
        if (!usage || !msg.sessionId) return;
        ledger.record(
          String(msg.sessionId),
          {
            input: Number(usage.input) || 0,
            output: Number(usage.output) || 0,
            total: Number(usage.total) || 0,
            cost: Number(usage.cost) || 0,
            updatedAt: new Date().toISOString(),
          },
          log,
        );
        ledger.compactIfBig();
        return;
      }
      case "deploy": {
        if (msg.action === "run") void runDeploy(msg.branch ? String(msg.branch) : undefined, Boolean(msg.stash));
        // 跳过构建、直接换脑：e2e 用它考「老脑→新脑」那一整段，真部署只是多一步编译。
        else if (msg.action === "swap") {
          const { ok: _ok, reason: _reason, ...rest } = deploy;
          deploy = { ...rest, phase: "running", at: Date.now() };
          spawnBrain({ swap: true });
        }
        return;
      }
      case "shutdown": {
        void stop(msg.scope === "group" ? "group" : "all");
        return;
      }
      case "bye": {
        b.conn.close();
        return;
      }
      case "ping": {
        b.conn.send({ t: "pong", at: Date.now() });
        return;
      }
      default:
        return;
    }
  }

  function brainLost(b: Brain, why: string): void {
    if (brain !== b) return;
    log(`${why}（pid ${b.pid}），着手重拉`);
    brain = null;
    // 子进程还活着：它们的行留在 broker 里，新脑 ready 后再 attach 时补上。
    setTimeout(() => {
      if (!shuttingDown && !brain && !starting) spawnBrain();
    }, RESPAWN_MS).unref();
  }

  // ---------------------------------------------------------------- 换脑
  /**
   * 新脑还没握手就死了：手上没有 Brain 对象，但部署状态必须从 running 里出来。
   * 不这样做的话 `deploy.phase` 会永远卡在 running，之后每次热部署都被「已有一轮在跑」默默吞掉。
   */
  function failDeployPid(pid: number, reason: string): void {
    if (starting && starting.pid === pid) return failDeploy(starting, reason);
    log(`换脑失败：${reason}`);
    swapPid = null;
    deploy = { phase: "failed", at: Date.now(), ok: false, reason };
    brain?.conn.send({ t: "deploy-state", ...deploy });
  }

  function observeThenSwitch(next: Brain): void {
    const old = brain;
    if (!old) return;
    deploy = { ...deploy, phase: "observing" };
    log(`新脑 ${next.pid} 就绪，观察 ${OBSERVE_MS / 1000}s 再切`);
    const timer = setTimeout(() => {
      if (starting !== next) return;
      if (!next.ready) return failDeploy(next, "观察期内新脑掉线");
      switchTo(next, old);
    }, OBSERVE_MS);
    timer.unref();
  }

  function switchTo(next: Brain, old: Brain): void {
    log(`切换：${old.pid} → ${next.pid}`);
    brain = next;
    starting = null;
    swapPid = null;
    expectingSwap = false;
    // 老脑认识、新脑还不认识的会话：把所有权先放空，等新脑 attach 时再给。
    for (const id of broker.sessions()) broker.setOwner(id, next.sessions.has(id) ? next.id : null);
    next.conn.send({ t: "activate", buildId: next.buildId });
    proxy.release();
    old.conn.send({ t: "retire" });
    setTimeout(() => old.conn.close(), 3000).unref();
    // 老脑 5 秒还没退：强杀（它已经不持有任何管道，杀掉不伤会话）。
    setTimeout(() => {
      if (!old.conn.alive) return;
      try {
        process.kill(old.pid);
      } catch {
        /* 已经没了 */
      }
    }, 5000).unref();
    deploy = { ...deploy, phase: "switched", at: Date.now(), ok: true, brainPid: next.pid };
    hostBuildId = selfFingerprint();
  }

  function failDeploy(b: Brain, reason: string): void {
    log(`换脑失败：${reason}`);
    swapPid = null;
    expectingSwap = false;
    deploy = { ...deploy, phase: "failed", at: Date.now(), ok: false, reason };
    if (starting === b) starting = null;
    try {
      b.conn.send({ t: "reject", reason });
      b.conn.close();
    } catch {
      /* 已经没了 */
    }
    const old = brain;
    if (old?.ready) old.conn.send({ t: "deploy-state", ...deploy });
  }

  async function runDeploy(branch?: string, stash = false): Promise<void> {
    if (deploy.phase === "running" || deploy.phase === "observing") {
      log("已有一轮部署在跑，忽略这次");
      return;
    }
    deploy = { phase: "running", at: Date.now() };
    const before = hostBuildId;
    // 壳自己的参数一律用「开关 + 值」的写法：worker 是 indexOf 找开关、取下一个参数。
    const args = [path.join(root, "scripts", "hotdeploy.mjs"), "--mode", "brain", "--port", String(port)];
    if (branch) args.push("--branch", branch);
    if (stash) args.push("--stash");
    log(`部署开始：node ${args.join(" ")}`);
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, PI_WEB_PORT: String(port), PI_HOST_LINK: sock },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const relay = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) if (line.trim()) log(`deploy| ${line}`);
    };
    child.stdout.on("data", relay);
    child.stderr.on("data", relay);
    const code: number = await new Promise((resolve) => child.on("exit", (c, s) => resolve(c ?? (s ? 1 : 0))));
    if (code !== 0) {
      deploy = { phase: "failed", at: Date.now(), ok: false, reason: `构建失败（退出码 ${code}）` };
      brain?.conn.send({ t: "deploy-state", ...deploy });
      return;
    }
    const after = selfFingerprint();
    if (after !== before) {
      // 壳自己变了：整组重启是唯一安全的出路（用户选定）。此刻不切，让面板红字预告。
      deploy = { phase: "needs-group-restart", at: Date.now(), ok: false, reason: "壳的代码也变了，需要整组重启" };
      brain?.conn.send({ t: "deploy-state", ...deploy });
      return;
    }
    spawnBrain({ swap: true });
  }

  // ---------------------------------------------------------------- 脑进程
  let spawnedForSwap = false;
  /** 为换脑拉起来的那代脑的 pid（握手前就死也要能认出它）。 */
  let swapPid: number | null = null;
  function spawnBrain(opts: { swap?: boolean } = {}): void {
    spawnedForSwap = Boolean(opts.swap);
    if (opts.swap) expectingSwap = true;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.PI_HOST_LINK = sock;
    env.PI_WEB_PORT = String(port);
    env.PI_HOST_PID = String(process.pid);
    env.PI_BUILD_ID = buildIdOnDisk() || env.PI_BUILD_ID || "";
    const child = spawn(process.execPath, [brainEntry], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (c: Buffer) => process.stdout.write(c));
    child.stderr.on("data", (c: Buffer) => process.stderr.write(c));
    const pid = child.pid;
    if (opts.swap && pid) swapPid = pid;
    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      if (swapPid === pid) {
        swapPid = null;
        expectingSwap = false;
        if (deploy.phase === "running" || deploy.phase === "observing") {
          failDeployPid(pid, `新脑在切换前退出（${code ?? signal}）`);
        }
      }
      if (starting && starting.pid === pid) {
        const cand = starting;
        starting = null;
        if (spawnedForSwap) failDeploy(cand, `新脑退出（${code ?? signal}）`);
      }
      if (brain && brain.pid === pid) brainLost(brain, `脑进程 ${pid} 退出（${code ?? signal}）`);
    });
    const t = setTimeout(() => {
      const pendingBrain = starting;
      if (pendingBrain && pendingBrain.pid === pid) failDeploy(pendingBrain, "新脑 30s 内没有握手");
      else if (!brain) log(`首个脑 ${pid} 60s 内没有就绪`);
    }, HELLO_MS);
    t.unref();
  }

  // ---------------------------------------------------------------- 停机
  async function stop(scope: "all" | "group"): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`停机（${scope}）`);
    try {
      brain?.conn.send({ t: "shutdown", scope });
    } catch {
      /* 脑已经不在 */
    }
    await new Promise((r) => setTimeout(r, 150));
    children.killAll();
    try {
      publicServer.close();
      control.close();
      proxy.release();
    } catch {
      /* 已经关了 */
    }
    setTimeout(() => process.exit(0), 300).unref();
  }

  // ---------------------------------------------------------------- 起飞
  await new Promise<void>((resolve) => publicServer.listen(port, listenHost, () => resolve()));
  try {
    writePidFile(port);
  } catch {
    /* pid 文件只是给外部脚本看的，写不进去不影响服务 */
  }
  log(`壳在 http://${listenHost}:${port}（buildId ${hostBuildId}），控制通道 ${sock}`);
  spawnBrain();

  process.on("SIGTERM", () => void stop("all"));
  process.on("SIGINT", () => void stop("all"));
  process.on("exit", () => {
    try {
      removePidFile(port);
    } catch {
      /* 不在就不在 */
    }
    try {
      if (process.platform !== "win32") fs.unlinkSync(sock);
    } catch {
      /* 不在就不在 */
    }
  });

  // 无人接的壳：90 秒没有脑连上就带着孩子一起走（不留幽灵）。
  let lastBrainSeen = Date.now();
  setInterval(() => {
    if (brain?.ready) lastBrainSeen = Date.now();
    if (shuttingDown) return;
    if (Date.now() - lastBrainSeen > 90_000) {
      log("90 秒没有可用的脑，收掉这一组");
      void stop("group");
    }
  }, 10_000).unref();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
