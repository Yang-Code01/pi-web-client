/**
 * 壳（host）：公网口的唯一持有者，也是所有 pi 子进程的父进程。
 *
 * 为什么要有这一层（D407）：热部署过去是「杀掉整个桥 → 起新桥」，于是 pi 子进程跟着死，
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
import { readPidFile, removePidFile, writePidFile } from "./pidfile.ts";
import { Broker } from "./host/broker.ts";
import { Children, type SpawnSpec } from "./host/children.ts";
import { BrainProxy } from "./host/proxy.ts";
import { CONTROL_PROTO, ControlConn, controlPath, serveControl, type ControlMessage } from "./host/control.ts";
import { UsageLedger } from "./host/ledger.ts";

/** pi 会等回答的扩展 UI 方法（docs/rpc-extension-ui.md 的 dialog methods）。其余都是只播报的。 */
const AWAITED_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

const VERSION = "0.1.0";
/** 新脑 ready 之后先观察这么久再切（用户选了「切完老脑立刻退」，所以观察必须在切换之前）。 */
const OBSERVE_MS = Number(process.env.PI_HOST_OBSERVE_MS ?? 5000) || 5000;
/** 脑崩了到重拉之间的间隔。 */
const RESPAWN_MS = 1000;
/** 主动停桥时给脑留的收尾时间：它要停评审、关会话，再把 link 关掉。 */
const STOP_GRACE_MS = 8000;
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
  /** 已经叫它去接管壳里活着的会话了（每个脑只叫一次，别重复 adopt）。 */
  askedAdopt: boolean;
  attachedAt: number;
  /** 子进程 exit 已经落地。换脑后强杀老脑前先看它一眼，别对复用的 pid 下手。 */
  exited: boolean;
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

/** 同步写到 fd 2：`npm start | tee` / CI 这类管道里，`console.error` 的异步写在 `process.exit`
 * 之前往往还没落盘，那几句人话会被截断，用户只看到半截。 */
function fail(line: string): void {
  try {
    fs.writeSync(2, `[host] ${line}\n`);
  } catch {
    console.error(`[host] ${line}`);
  }
}

/**
 * 端口被占时给一句人话（D448）：以前这里是未捕获的 EADDRINUSE，用户只看到一坨堆栈。
 *
 * 认出占用者的活主要在 `scripts/preflight.mjs`（命令行、pid 文件、枚举三条线索都在它那儿），
 * 壳在 listen 这一刻只有 pid 文件可看 —— 够指路了：正常情况下 preflight 已经问过并停掉了旧的那份，
 * 走到这里说明是「检查完到 listen 之间被抢」或者绕过 preflight 直起了桥。
 */
function explainPortTaken(port: number): void {
  const pid = readPidFile(port);
  const who = pid ? `pid 文件里记着 ${pid}` : "认不出占用者";
  fail(
    `端口 ${port} 已被占用（${who}），壳没有起来。\n` +
      `  先看看是谁、要不要停掉它：node scripts/preflight.mjs\n` +
      `  自己停掉：npm run bridge:stop\n` +
      `  换个端口：PI_WEB_PORT=<别的口> npm start`,
  );
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
const brainsByPid = new Map<number, Brain>();
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
  // 用量账本：跨换代、跨整组重启都活着（D407）。开壳时把上次的账读回来。
  const ledger = new UsageLedger(statePath("host", "usage.jsonl"));
  if (ledger.size) log(`账本里已有 ${ledger.size} 个会话的用量`);
  /** 每个会话还没被回答的 extension_ui_request（问卷 / 审批）：换脑时页面上的表单不能凭空消失。 */
  const pendingUi = new Map<string, Map<string, string>>();
  /** 每个会话这一轮还在不在跑（换脑后脑要靠它把 running 恢复出来）。 */
  const turns = new Map<string, boolean>();
  const snapshotSessions = () => broker.sessions().map((id) => ({ id, turnActive: Boolean(turns.get(id)) }));
  let brain: Brain | null = null;
  let starting: Brain | null = null;
  /** 刚为换脑拉起了一代、还没握手：它的 hello 要当候选，而不是「多余的脑」。 */
  let expectingSwap = false;
  /** 这次交换对应的子进程；握手前就退出时靠它认人，而不是只看 pid。 */
  let swapChild: ReturnType<typeof spawn> | null = null;
  let hostBuildId = selfFingerprint();
  /**
   * 磁盘上的壳代码已经和正在跑的这份不一样了？面板要在用户点下去之前就说「这一次会连会话
   * 一起重启」（D407 story 23）—— 等到构建完才发现就晚了。指纹读文件，5 秒缓存。
   */
  let staleAt = 0;
  let stale = false;
  const hostStale = (): boolean => {
    if (Date.now() - staleAt > 5000) {
      staleAt = Date.now();
      stale = selfFingerprint() !== hostBuildId;
    }
    return stale;
  };
  let deploy: DeployState = { phase: "idle", at: 0 };
  /** 所有部署状态变更都从这里走：壳自己记住，同时立刻告诉当前脑。
   *  不发的话脑的 deployState 会停在 idle，面板的 busy 检查与 running 映射整段失效。 */
  function publishDeploy(next: DeployState): void {
    deploy = next;
    brain?.conn.send({ t: "deploy-state", ...next });
  }
  let shuttingDown = false;

  /** 从一帧 extension_ui_request 里取 id：同一张表单可能同时躺在未确认窗口和 pendingUi 里。 */
  function uiIdOf(line: string): string {
    if (!line.includes('"extension_ui_request"')) return "";
    try {
      return String(JSON.parse(line)?.id ?? "");
    } catch {
      return "";
    }
  }

  /**
   * 记下一条还没答的 extension_ui_request（按 id 去重；同一条被重放多少次都只有一份）。
   * 只记等回答的对话类（select / confirm / input / editor）：notify / setStatus / setWidget /
   * setTitle / set_editor_text 永远不会有 extension_ui_response 来消掉它，记下来只会越攒越多：
   * 长会话里上万条播报帧把 attach 的回帧撑到控制通道吞不下，接管一律「壳 attached 超时」。
   */
  function rememberUi(sessionId: string, line: string): void {
    try {
      const msg = JSON.parse(line);
      const id = String(msg?.id ?? "");
      if (!id) return;
      if (!AWAITED_UI_METHODS.has(String(msg?.method ?? ""))) return;
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
      else if (line.includes('"agent_end"')) {
        turns.set(sessionId, false);
        // 一轮结束了：重放窗口留着只会把上一轮的行倒给下一代脑（D407「turn 结束即丢弃」）。
        broker.endTurn(sessionId);
      }
      // 还没答的问卷 / 审批留在壳里：换脑后由新脑重放，否则页面那张表单就哑了（D407）。
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
      turns.delete(sessionId);
      pendingUi.delete(sessionId);
      // 进程没了，这一轮的窗口也就没人可交了：留着它只会让下一次 attach 拿到幽灵行。
      broker.detach(sessionId);
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
    hostStale: hostStale(),
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
      // 只认本服务自己的 host:port。放行任意 localhost 端口等于把本机其它 Web 服务
      // 也当成自己页面 —— 它们可以跨源 POST 停机/部署。开发态的 Vite 代理会原样保留
      // 浏览器的 Host（localhost:5173），所以精确比较仍然成立。
      const host = String(req.headers.host ?? "");
      return host !== "" && u.host === host;
    } catch {
      return false;
    }
  };

  const publicServer = http.createServer((req, res) => {
    // 不用请求里的 Host 拼 base：畸形 Host（比如 `evil:bad`）会让 new URL 抛异常，
    // 而这里在 http 请求回调里，未捕获就是壳整个退出。路径解析本来也不需要 Host。
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return void json(res, 400, { ok: false, code: "bad-url" });
    }
    if (url.pathname === "/healthz") {
      // 回环请求才给完整 state；远程访客只拿「活着 + 版本」，别把会话 id、子进程 pid、
      // 部署状态和缓冲窗口当成公开健康检查的一部分。
      const body = hostOnly(req)
        ? { ...state(), pid: process.pid, public: isTunnelish(req) }
        : { ok: true, version: VERSION, buildId: hostBuildId, hostStale: hostStale(), public: true };
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
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
      // 更新器（bridge-update / hotdeploy）先走 keepReviews=1：它马上会起新壳，
      // detached 评审 worker 要留给新脑接回。普通停止（页面 / SIGTERM / SIGINT）走默认值，
      // 必须把评审收掉，否则 systemd stop 之后 worker 会一直跑到 30 分钟超时。
      const keepReviews = url.searchParams.get("keepReviews") === "1";
      void stop("all", !keepReviews);
      return void json(res, 200, { ok: true, stopping: true, keepReviews });
    }
    if (url.pathname === "/api/host/deploy" && req.method === "POST") {
      if (!hostOnly(req)) return void json(res, 403, { ok: false, code: "non-loopback" });
      if (!sameOrigin(req)) return void json(res, 403, { ok: false, code: "cross-origin" });
      const action = url.searchParams.get("action") ?? "run";
      if (action === "run") void runDeploy(url.searchParams.get("branch") ?? undefined, url.searchParams.get("stash") === "1");
      // 跳过构建、直接拉一代新脑：e2e 和手工排障用（真部署只是多一步编译）。
      // 改不到壳自己：壳的指纹变了 runDeploy 才会要求整组重启，这里只是换脑。
      else if (action === "swap" && deploy.phase !== "running" && deploy.phase !== "observing" && !starting && !swapChild) {
        publishDeploy({ phase: "running", at: Date.now() });
        spawnBrain({ swap: true });
      }
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
    conn.onMessage((msg: ControlMessage) => {
      if (!msg || typeof msg.t !== "string") return;
      if (msg.t === "hello") {
        candidate = onHello(conn, msg);
        return;
      }
      if (!candidate) return;
      onBrainMessage(candidate, msg);
    });
  }

  function onHello(conn: ControlConn, msg: ControlMessage): Brain | null {
    const next: Brain = {
      id: newBrainId(),
      conn,
      pid: Number(msg.pid) || 0,
      buildId: String(msg.buildId ?? ""),
      internalPort: Number(msg.internalPort) || 0,
      ready: false,
      sessions: new Set(),
      askedAdopt: false,
      attachedAt: Date.now(),
      exited: false,
    };
    if (next.pid > 0) brainsByPid.set(next.pid, next);
    if (msg.proto !== CONTROL_PROTO) {
      log(`拒绝握手：proto ${msg.proto} ≠ ${CONTROL_PROTO}`);
      conn.send({ t: "reject", reason: `proto-mismatch:${CONTROL_PROTO}` });
      conn.close();
      // 拒绝就是拒绝：不能把 next 交给 onMessage，否则 close 落地前的 ready / spawn /
      // stdin / shutdown 仍会被当成一个合法脑执行。
      return null;
    }
    if (!brain) {
      brain = next;
      conn.send({ t: "welcome", proto: CONTROL_PROTO, peerHeader: "x-pi-peer", hostBuildId, publicPort: port });
      conn.send({ t: "snapshot", hostBuildId, hostStale: hostStale(), publicPort: port, buildId: next.buildId, sessions: snapshotSessions() });
      conn.send({ t: "usage-snapshot", sessions: ledger.snapshot() });
      conn.send({ t: "deploy-state", ...deploy });
      log(`脑 ${next.pid} 连上（首个，buildId ${next.buildId || "?"}）`);
      return next;
    }
    if (
      expectingSwap &&
      swapChild &&
      swapChild.exitCode === null &&
      !swapChild.killed &&
      swapPid !== null &&
      swapPid === next.pid
    ) {
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
      conn.send({ t: "snapshot", hostBuildId, hostStale: hostStale(), publicPort: port, buildId: next.buildId, sessions: snapshotSessions() });
      conn.send({ t: "usage-snapshot", sessions: ledger.snapshot() });
      conn.send({ t: "deploy-state", ...deploy });
      return next;
    }
    if (expectingSwap && (!swapChild || swapChild.exitCode !== null || swapChild.killed || swapPid === null)) {
      // 等的那代脑已经不在了：不把 deploy 从 running 里放出来，后面每次部署都会被当成「已有
      // 一轮在跑」吞掉；同时这枚刚连上的候选也不能当它用。
      const gone = swapPid ?? -1;
      log(`换脑候选 ${next.pid} 到达时，这次交换的子进程已经不在了（pid ${gone > 0 ? gone : "?"}），拒绝`);
      swapChild = null;
      swapPid = null;
      expectingSwap = false;
      failDeployPid(gone, "候选脑在握手前退出");
      conn.send({ t: "reject", reason: "swap-child-gone" });
      conn.close();
      return null;
    }
    // 既不是首个、也没有人在等它：多出来的脑，让它退。
    log(`多余的脑 ${next.pid}，拒绝`);
    conn.send({ t: "reject", reason: "unexpected" });
    conn.close();
    return null;
  }

  function onBrainMessage(b: Brain, msg: ControlMessage): void {
    switch (msg.t) {
      case "ready": {
        b.ready = true;
        if (brain === b) {
          log(`脑 ${b.pid} 就绪`);
          proxy.release();
          // 壳崩后重拉的那代脑是「首个」，但它接手的不是空壳：子进程还在跑、行还在窗口里。
          // 必须叫它 adopt，否则页面退回只读、running 报 0，会话就成了没人解释的孤儿（D407）。
          if (!b.askedAdopt && broker.sessions().length) {
            b.askedAdopt = true;
            log(`叫脑 ${b.pid} 接管 ${broker.sessions().length} 个还活着的会话`);
            b.conn.send({ t: "activate", buildId: b.buildId, resumed: true });
          }
          return;
        }
        if (starting === b) {
          observeThenSwitch(b);
          return;
        }
        return;
      }
      case "spawn": {
        // 换脑已经完成：老脑还挂着的那几秒不许再开新会话、抢所有权。
        if (b !== brain) {
          b.conn.send({ t: "spawn-failed", rid: msg.rid, reason: "stale-owner" });
          return;
        }
        const spec: SpawnSpec = {
          sessionId: String(msg.sessionId),
          argv: Array.isArray(msg.argv) ? msg.argv.map(String) : [],
          cwd: String(msg.cwd ?? process.cwd()),
          env: msg.env && typeof msg.env === "object" ? (msg.env as Record<string, string>) : {},
        };
        try {
          const pid = children.start(spec);
          b.sessions.add(spec.sessionId);
          broker.setOwner(spec.sessionId, b.id);
          b.conn.send({ t: "spawned", rid: msg.rid, pid });
        } catch (err) {
          b.conn.send({ t: "spawn-failed", rid: msg.rid, reason: String((err as Error).message ?? err) });
        }
        return;
      }
      case "attach": {
        // 切换后老脑的控制连接还会留几秒；它这时发来的 attach 不能重新拿到会话，
        // 否则 stale-owner 隔离失效，后续某些写会被旧脑错误地接受。
        if (b !== brain) {
          b.conn.send({ t: "attach-failed", rid: msg.rid, reason: "stale-owner" });
          return;
        }
        const sessionId = String(msg.sessionId);
        if (!children.has(sessionId)) {
          b.conn.send({ t: "attach-failed", rid: msg.rid, reason: "no-child" });
          return;
        }
        b.sessions.add(sessionId);
        broker.setOwner(sessionId, b.id);
        const p = broker.pending(sessionId);
        // 老脑死前没 ack 的问卷会同时留在 broker 的未确认窗口和 pendingUi 里；两处都交给新脑，
        // 它就会把同一张卡片投两次（approvals 覆盖后重发，问卷直接多一张）。以 pending 里的行为准。
        const replayedUi = new Set(p.lines.map((l) => uiIdOf(l.line)).filter(Boolean));
        const carriedUi = [...(pendingUi.get(sessionId)?.values() ?? [])].filter((line) => {
          const id = uiIdOf(line);
          return !id || !replayedUi.has(id);
        });
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
          pendingUi: carriedUi,
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
        // 换脑完成后老脑还会挂几秒；它这时发来的 kill 不能杀掉新脑已经接管的会话进程。
        if (b !== brain) {
          log(`忽略旧脑 ${b.pid} 发来的 kill（会话 ${String(msg.sessionId)}）`);
          return;
        }
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
          if (deploy.phase === "running" || deploy.phase === "observing" || starting || swapChild) {
            log("已有一轮部署/换脑在跑，忽略这次 swap");
            b.conn.send({ t: "deploy-state", ...deploy });
            return;
          }
          const { ok: _ok, reason: _reason, ...rest } = deploy;
          publishDeploy({ ...rest, phase: "running", at: Date.now() });
          spawnBrain({ swap: true });
        }
        return;
      }
      case "shutdown": {
        // 同一个窗口里，退休的老脑也不能把整组停掉；停机的决定只属于当前脑。
        if (b !== brain) {
          log(`忽略旧脑 ${b.pid} 发来的 shutdown`);
          return;
        }
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
      // 换脑期间别插一代普通脑：候选脑还没握手时 expectingSwap 已经为真，
      // 这时再 spawn 只会多一个被拒的进程，干扰交换。
      if (!shuttingDown && !brain && !starting && !expectingSwap && !swapChild) spawnBrain();
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
    publishDeploy({ phase: "failed", at: Date.now(), ok: false, reason });
  }

  function observeThenSwitch(next: Brain): void {
    const old = brain;
    if (!old) return;
    publishDeploy({ ...deploy, phase: "observing" });
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
    swapChild = null;
    expectingSwap = false;
    next.askedAdopt = true;
    // 老脑认识、新脑还不认识的会话：把所有权先放空，等新脑 attach 时再给。
    for (const id of broker.sessions()) broker.setOwner(id, next.sessions.has(id) ? next.id : null);
    proxy.release();
    old.conn.send({ t: "retire" });
    // 会话锁是在 retire 处理里才交出来的（releaseLocks）。activate 若抢在它前面发，新脑的
    // takeLock 会撞上老脑还没删的锁，adopt 直接失败、页面上会话退回只读 —— 所以等老脑的
    // 控制连接断开（它 releaseLocks 之后才 exit）再叫新脑接管；1 秒还没断就照发，不拖住换脑。
    let activated = false;
    const activate = (): void => {
      if (activated) return;
      activated = true;
      next.conn.send({ t: "activate", buildId: next.buildId });
    };
    if (!old.conn.alive) activate();
    else {
      old.conn.onClose(activate);
      setTimeout(activate, 1000).unref();
    }
    setTimeout(() => old.conn.close(), 3000).unref();
    // 老脑 5 秒还没退：强杀（它已经不持有任何管道，杀掉不伤会话）。
    setTimeout(() => {
      // 连接断了不代表进程退了：旧脑可能关了控制口却卡住不退，这里必须照样强杀。
      if (old.exited) return;
      try {
        if (process.platform === "win32") process.kill(old.pid);
        else process.kill(old.pid, "SIGKILL");
      } catch {
        /* 已经没了 */
      }
    }, 5000).unref();
    publishDeploy({ ...deploy, phase: "switched", at: Date.now(), ok: true, brainPid: next.pid });
    hostBuildId = selfFingerprint();
  }

  function failDeploy(b: Brain, reason: string): void {
    log(`换脑失败：${reason}`);
    swapPid = null;
    swapChild = null;
    expectingSwap = false;
    publishDeploy({ ...deploy, phase: "failed", at: Date.now(), ok: false, reason });
    if (starting === b) starting = null;
    try {
      b.conn.send({ t: "reject", reason });
      b.conn.close();
    } catch {
      /* 已经没了 */
    }
  }

  async function runDeploy(branch?: string, stash = false): Promise<void> {
    if (deploy.phase === "running" || deploy.phase === "observing") {
      log("已有一轮部署在跑，忽略这次");
      return;
    }
    publishDeploy({ phase: "running", at: Date.now() });
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
      windowsHide: true,
    });
    const relay = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) if (line.trim()) log(`deploy| ${line}`);
    };
    child.stdout.on("data", relay);
    child.stderr.on("data", relay);
    // spawn 失败（EAGAIN、入口被删）只发 'error'、不发 'exit'：不接住就是未捕获异常崩壳，
    // await 也永远不结算，deploy 卡在 running，之后每一轮都被「已有一轮在跑」吞掉。
    const spawnState = { error: null as Error | null };
    const code: number = await new Promise<number>((resolve) => {
      let settled = false;
      const done = (n: number): void => {
        if (settled) return;
        settled = true;
        resolve(n);
      };
      child.on("error", (err) => {
        spawnState.error = err;
        log(`部署子进程起不来：${err.message}`);
        done(-1);
      });
      child.on("exit", (c, s) => done(c ?? (s ? 1 : 0)));
    });
    if (spawnState.error || code !== 0) {
      const reason = spawnState.error ? `部署子进程起不来：${spawnState.error.message}` : `构建失败（退出码 ${code}）`;
      publishDeploy({ phase: "failed", at: Date.now(), ok: false, reason });
      return;
    }
    const after = selfFingerprint();
    if (after !== before) {
      // 壳自己变了：整组重启是唯一安全的出路（用户选定）。此刻不切，让面板红字预告。
      publishDeploy({ phase: "needs-group-restart", at: Date.now(), ok: false, reason: "壳的代码也变了，需要整组重启" });
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
      windowsHide: true,
    });
    child.stdout.on("data", (c: Buffer) => process.stdout.write(c));
    child.stderr.on("data", (c: Buffer) => process.stderr.write(c));
    const pid = child.pid;
    if (opts.swap && pid) swapPid = pid;
    if (opts.swap) swapChild = child;
    let errored = false;
    // 和部署子进程同一条教训：spawn 失败只发 'error'。脑起不来不该把持有公网口和全部
    // 会话管道的壳带走；还在等这一代脑的部署也必须当场收尾，不能永远停在 running。
    child.on("error", (err) => {
      errored = true;
      const reason = `脑进程起不来：${err.message}`;
      log(reason);
      if (opts.swap && swapChild === child) {
        swapChild = null;
        swapPid = null;
        expectingSwap = false;
        if (deploy.phase === "running" || deploy.phase === "observing") {
          publishDeploy({ phase: "failed", at: Date.now(), ok: false, reason });
        }
      }
      if (starting && starting.pid === pid) {
        const cand = starting;
        starting = null;
        failDeploy(cand, reason);
      }
    });
    child.on("exit", (code, signal) => {
      if (shuttingDown || errored) return;
      const dead = brainsByPid.get(pid ?? -1);
      if (dead) {
        dead.exited = true;
        brainsByPid.delete(pid ?? -1);
      }
      if (swapChild === child) {
        swapChild = null;
        swapPid = null;
        expectingSwap = false;
        if (deploy.phase === "running" || deploy.phase === "observing") {
          failDeployPid(pid ?? -1, `新脑在切换前退出（${code ?? signal}）`);
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
      else if (!brain) log(`首个脑 ${pid ?? "?"} ${HELLO_MS / 1000}s 内没有就绪`);
    }, HELLO_MS);
    t.unref();
  }

  // ---------------------------------------------------------------- 停机
  async function stop(scope: "all" | "group", tellBrain = true): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`停机（${scope}${tellBrain ? "" : "，保留评审"}）`);
    const waitBrainClose = (conn: ControlConn | null | undefined): Promise<void> =>
      new Promise((resolve) => {
        if (!conn?.alive) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, STOP_GRACE_MS);
        timer.unref();
        conn.onClose(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    if (tellBrain) {
      // 先挂 close 监听再发 shutdown：脑可能反应很快，send 之后才注册会漏掉断开。
      // 不等的话壳会在 300ms 后退出，脑的 link.on("closed") 立刻 process.exit，
      // stopAllReviews() 的 3 秒收尾和状态写回都被截断，用户主动关桥也可能留下 worker。
      // 这里的 8 秒比 stopAllReviews 的 3 秒上限长；requestCancel 里的 10 秒只是兜底
      // 定时器，不参与等待，别把它算进停机路径。
      // 壳可能正好在换脑（brain 已下、starting 还没 hello）：能发就发给 handshake 中的那一代，
      // 发不出去也没关系，后面的 killAll + 壳退出会让它收尾。
      const target = brain ?? starting;
      const conn = target?.conn;
      const closed = waitBrainClose(conn);
      try {
        conn?.send({ t: "shutdown", scope });
      } catch {
        /* 脑已经不在 */
      }
      await closed;
      if (target && !target.exited && target.conn.alive) {
        try {
          process.kill(target.pid, "SIGKILL");
        } catch {
          /* 已经退了 */
        }
      }
    } else {
      // 只有更新器显式请求 `keepReviews=1` 才走到这里：它马上会起新壳，detached 评审
      // worker 要留给新脑接回。这里用 `retire`（换代语义）而不是 shutdown：后者会
      // sessions.shutdown()，而 150ms 后 children.killAll() 的 SIGTERM 还会让脑按「真正停桥」
      // 把评审收掉。等脑自己退（retire 只 releaseLocks）：慢机器上 releaseLocks 也可能
      // 超过 2 秒，等太短会让随后的 SIGTERM 变成 shutdown()，把刚保住的 worker 收掉。
      // 所以和普通停机用同一段 STOP_GRACE_MS；正常情况脑会立刻退出。
      const target = brain ?? starting;
      const conn = target?.conn;
      const closed = waitBrainClose(conn);
      try {
        conn?.send({ t: "retire" });
      } catch {
        /* 脑已经不在 */
      }
      await closed;
      if (target && !target.exited && target.conn.alive) {
        try {
          process.kill(target.pid, "SIGKILL");
        } catch {
          /* 已经退了 */
        }
      }
    }
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

  /**
   * 起飞失败时自己收摊再退。
   *
   * 控制通道是先起的（`serveControl` 在起飞之前），直接 `process.exit` 会把 unix socket 文件
   * 留在盘上（`net.Server.close()` 不删文件），下一轮只能靠 `control.ts` 里的 EADDRINUSE
   * 探测兜底去清；Windows 的命名管道虽无残留文件，也没必要让一个注定要死的壳继续接受连接。
   * 这时还没有脑、没有子进程（`spawnBrain` 在起飞之后），不用管它们。
   */
  function bail(code: number): never {
    try {
      control.close();
    } catch {
      /* 已经关了 */
    }
    try {
      proxy.release();
    } catch {
      /* 没有隧道 */
    }
    if (process.platform !== "win32") {
      try {
        fs.unlinkSync(sock);
      } catch {
        /* 删不掉就留着，下一轮的 controlInUse 探测会兜底 */
      }
    }
    process.exit(code);
  }

  // ---------------------------------------------------------------- 起飞
  // listen 的 error 必须接住：EADDRINUSE 以前是一条未捕获异常，用户看到的是整个堆栈（D448）。
  const listenError = await new Promise<Error | null>((resolve) => {
    const onError = (err: Error): void => {
      publicServer.off("error", onError);
      resolve(err);
    };
    publicServer.once("error", onError);
    publicServer.listen(port, listenHost, () => {
      publicServer.off("error", onError);
      resolve(null);
    });
  });
  if (listenError) {
    const code = (listenError as NodeJS.ErrnoException).code;
    if (code !== "EADDRINUSE") {
      // 其它 listen 错误（EACCES 绑特权口、EADDRNOTAVAIL 绑不存在的地址）同样不该甩堆栈。
      fail(`壳没能监听 ${listenHost}:${port}（${code ?? "未知错误"}）：${listenError.message}`);
      fail(`  换一个地址/端口试试：PI_WEB_HOST=127.0.0.1 PI_WEB_PORT=<别的口> npm start`);
      bail(1);
    }
    explainPortTaken(port);
    bail(2);
  }
  try {
    writePidFile(port);
  } catch {
    /* pid 文件只是给外部脚本看的，写不进去不影响服务 */
  }
  log(`壳在 http://${listenHost}:${port}（buildId ${hostBuildId}），控制通道 ${sock}`);
  spawnBrain();

  // D446：更新器（bridge-update / hotdeploy）先 POST /api/host/stop?keepReviews=1，再杀旧壳；
  // 那条路径保留 detached 评审 worker。普通 SIGTERM / SIGINT 是真正停桥，必须把评审收掉。
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
  let lastStale = hostStale();
  setInterval(() => {
    if (brain?.ready) lastBrainSeen = Date.now();
    if (shuttingDown) return;
    // 壳自己的代码变了要尽快让面板知道（点击前红字预告，D407 story 23）。
    const stale = hostStale();
    if (stale !== lastStale) {
      lastStale = stale;
      brain?.conn.send({ t: "host-stale", stale });
    }
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
