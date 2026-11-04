import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  authorized,
  clearedCookie,
  clientIp,
  currentPassphrase,
  ensurePassphrase,
  isTunnelRequest,
  issueSessionToken,
  loginAllowed,
  setPassphrase,
  resetLoginAttempts,
  sessionCookie,
  verifyPassphrase,
} from "./auth.ts";
import { stateDir } from "./paths.ts";
import { Terminals, openConsole, revealInFileManager } from "./terminal.ts";
import { SessionManager, isPermissionMode, type AskAnswer, type AskQuestion } from "./sessions.ts";
import { bumpSkillUsage } from "./skills.ts";
import { Notifier } from "./notify.ts";
import { anyPresent, dropClient, reportPresence } from "./presence.ts";
import { Tunnel, findCloudflared } from "./tunnel.ts";
import { resolvePi, readVersion } from "./pi.ts";
import { APP_NAME, VERSION, agentDir, ensureStateDirs, readJson, statePath, sessionsRootInfo } from "./paths.ts";
import { clipboardFiles, listDirs, makeDir, statFiles } from "./dirs.ts";
import { gitInfo } from "./git.ts";
import { listFiles, rankFiles } from "./filesearch.ts";
import { changelog, installLockExt, lockExtStatus, readSettings, setTrust, trustInfo, uninstallLockExt, writeSettings } from "./pisettings.ts";
import { cleanLaunch } from "./launch.ts";
import { isWriteOp, runPiCli } from "./picli.ts";
import { reportBug, shareSession } from "./pishare.ts";
import {
  addShot,
  deleteNote,
  listNotes,
  purgeTrash,
  removeShot,
  saveNote,
  setNoteLife,
  setNoteStatus,
  type NoteKind,
  type NoteLife,
  type NoteMode,
  type NoteStatus,
} from "./notes.ts";
import { mcpAddRequest, newer, searchMcp, searchPackages, type McpInstallOption } from "./market.ts";
import { bumpMcp, inventory, readUiPrefs, toggleExtension, toggleMcp, updateCount, writeUiPrefs } from "./extmgr.ts";
import { createWriteLock } from "./writelock.ts";
import { answer as answerLogin, cancel as cancelLogin, listProviders, login as startLogin, logout as logoutProvider } from "./pilogin.ts";
import { piLatest } from "./piupdate.ts";
import { openPreview, readAttachableImage, rememberEditable, savePreviewFile, serveRaw } from "./preview.ts";
import { PeerHost, peerEntry } from "./peer.ts";

interface Config {
  port: number;
  host: string;
  tunnelAuto: boolean;
  /** 局域网 peer 的 HTTP 端口（#45）；`PI_PEER=0` 关掉整块功能。 */
  peerPort: number;
}

const STEP_UP_MS = 10 * 60 * 1000;
const MAX_BODY = 30 * 1024 * 1024;

function loadConfig(): Config {
  const cfg = readJson<Partial<Config>>(statePath("config.json"), {});
  return {
    port: Number(process.env.PI_WEB_PORT || cfg.port || 7864),
    host: process.env.PI_WEB_HOST || cfg.host || "127.0.0.1",
    tunnelAuto: process.env.PI_WEB_TUNNEL === "1" || Boolean(cfg.tunnelAuto),
    peerPort: Number(process.env.PI_PEER_PORT || 7865),
  };
}

const WEB_ROOT = (() => {
  const found: string[] = [];
  if (process.env.PI_WEB_ROOT) found.push(process.env.PI_WEB_ROOT);
  try {
    found.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist"));
  } catch {
    /* import.meta.url unusable (exotic loader) — fall through to cwd */
  }
  found.push(path.resolve(process.cwd(), "web", "dist"));
  return found.find((p) => fs.existsSync(p)) ?? found[found.length - 1];
})();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

function serveStatic(res: http.ServerResponse, rel: string): void {
  const clean = rel.split("?")[0];
  // 第二张页面：`/peer` 落到 peer.html，不能掉进 index.html 兜底（否则打开的是聊天界面）。
  const wanted = clean === "/peer" || clean === "/peer/" ? "/peer.html" : clean;
  const target = path.join(WEB_ROOT, path.normalize(wanted).replace(/^([/\\])+/, ""));
  const file = target.startsWith(WEB_ROOT) && fs.existsSync(target) && fs.statSync(target).isFile() ? target : path.join(WEB_ROOT, "index.html");
  if (!fs.existsSync(file)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("web 前端还没构建：在 web/ 下跑 npm run build");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
    // 页面入口不进缓存：bundle 带构建哈希，HTML 却会一直指向上一版的哈希。
    // peer.html 之前按「非 index.html」拿 3600 秒缓存 —— 改完页面，弹框里还是旧 JS。
    "cache-control": file.endsWith(".html") ? "no-store" : "public, max-age=3600",
  });
  fs.createReadStream(file).pipe(res);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (err) {
        reject(err as Error);
      }
    });
    req.on("error", reject);
  });
}

/** 读原始字节（上传剪贴板图片）。和 readBody 的区别只有「不 JSON.parse」。 */
function readRaw(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string | string[]> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
  res.end(payload);
}

/**
 * D110：错误响应带**稳定错误码**。`error` 仍是中文兜底句（日志、curl、旧前端都还读它），
 * 前端拿 `code` + `params` 去查词典（`bridge.err.<code>`），查不到才显示 `error`。
 * 码一旦发出去就别改名：改名的代价是用户界面里出现一句中文兜底。
 */
function fail(
  res: http.ServerResponse,
  status: number,
  code: string,
  error: string,
  params?: Record<string, string | number>,
  extra: Record<string, unknown> = {},
): void {
  json(res, status, { ...extra, error, code, ...(params ? { params } : {}) });
}

/**
 * Whatever the child posts is untrusted input: drop questions without a prompt, invent ids and
 * labels, and accept options as bare strings (the `question` tool) or objects (the `questionnaire`).
 */
function normalizeAskQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const [i, q] of raw.entries()) {
    const prompt = String((q as any)?.prompt ?? (q as any)?.question ?? "").trim();
    if (!prompt) continue;
    const options = Array.isArray((q as any)?.options)
      ? ((q as any).options as any[])
          .map((o: any) =>
            typeof o === "string"
              ? { value: o, label: o }
              : {
                  value: String(o?.value ?? o?.label ?? ""),
                  label: String(o?.label ?? o?.value ?? ""),
                  description: o?.description ? String(o.description) : undefined,
                },
          )
          .filter((o) => o.label)
      : [];
    out.push({
      id: String((q as any)?.id ?? `q${i + 1}`),
      label: (q as any)?.label ? String((q as any).label) : `Q${i + 1}`,
      prompt,
      options,
      allowOther: (q as any)?.allowOther !== false,
    });
  }
  return out;
}

/**
 * `node dist/index.js --passphrase <value>` rewrites the login passphrase and exits.
 * Cookies are signed with an unrelated secret, so devices already logged in stay in.
 */
function handlePassphraseFlag(argv: string[]): boolean {
  const at = argv.indexOf("--passphrase");
  if (at < 0) return false;
  const value = (argv[at + 1] ?? "").trim();
  if (value.length < 4) {
    console.log("口令至少 4 个字符");
    process.exit(1);
  }
  ensureStateDirs();
  setPassphrase(value);
  console.log(`口令已改为：${value}`);
  console.log(`状态目录：${stateDir()}`);
  return true;
}

async function main(): Promise<void> {
  if (handlePassphraseFlag(process.argv.slice(2))) return;
  ensureStateDirs();
  const cfg = loadConfig();
  const fresh = ensurePassphrase();
  const pi = resolvePi();
  // #49: `pi update` replaces the package on disk while this process keeps running, so the version
  // the page shows is re-read after a successful self-update instead of staying frozen at boot.
  let piVersion = pi.version;
  /** #21: trust state for a cwd, or null when pi's trust module cannot be loaded / cwd is gone. */
  const trustFor = async (cwd: string) => {
    if (!cwd || !fs.existsSync(cwd)) return null;
    try {
      return await trustInfo(pi.cli, cwd);
    } catch {
      return null;
    }
  };
  const sessions = new SessionManager(pi.cli, `http://127.0.0.1:${cfg.port}/api/ask`);
  /** D113: one writer per shared resource (`npm` root, each settings scope, each mcp.json). */
  const writeLock = createWriteLock();
  /**
   * The mcp.json `pi mcp add/remove` writes: the global one, or the project's with `--local`. The
   * toggles take `mcp:<file>` as their lock, so an add has to take it too — otherwise it can land on
   * top of a toggle that read the same file a moment earlier.
   */
  const mcpFileLock = (local: boolean, cwd: string | null) => `mcp:${path.join(local && cwd ? path.join(cwd, ".pi") : agentDir(), "mcp.json")}`;
  const notifier = new Notifier();
  const tunnelBin = findCloudflared();
  const tunnel = new Tunnel(cfg.port, tunnelBin ?? "");

  // 第 5 片：pi 子进程里的 peer_* 工具直连 peer 的回环端口（决定 33）。
  // rpc.ts 起子进程时是 `{...process.env, ...opts.env}`，所以这里设一次就传下去了。
  process.env.PI_PEER_PORT = String(cfg.peerPort);

  const log = (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}`;
    console.log(line);
    try {
      fs.appendFileSync(statePath("logs", "bridge.log"), line + "\n");
    } catch {
      /* ignore */
    }
  };

  log(`${APP_NAME} ${VERSION} — pi ${piVersion} @ ${pi.cli}`);
  // Q-032: 扩展丢了就只剩「模型把表单写成文字」，而那是无声的。启动时把在场情况写进日志。
  try {
    const dir = path.join(os.homedir(), ".pi", "agent", "extensions");
    const seen = ["question.ts", "questionnaire.ts"].map((n) => `${n.replace(/\.ts$/, "")}=${fs.existsSync(path.join(dir, n)) ? "在" : "缺"}`);
    log(`ask 扩展：${seen.join(" ")}（缺了就只能由模型把表单写成文字）`);
  } catch {
    /* 只是诊断信息 */
  }

  // Last line of defence: a single stray stream error used to kill the whole bridge (and with it
  // every connected client). Log it loudly and keep serving — sessions each own their child and
  // their file tail, so the rest of the server stays consistent.
  const survive = (kind: string) => (err: unknown) => {
    const e = err as any;
    log(`${kind}: ${(e?.stack ?? e?.message ?? String(err)).toString().slice(0, 4000)}`);
  };
  process.on("uncaughtException", survive("uncaughtException"));
  process.on("unhandledRejection", survive("unhandledRejection"));

  // #45：peer 是独立子进程（自己绑 7865、要被局域网访问），bridge 只托管它并把状态转给页面。
  const peerOn = process.env.PI_PEER !== "0";
  const peer = new PeerHost({ port: cfg.peerPort, entry: peerOn ? peerEntry() : null, log });
  if (peerOn) peer.start();
  else log("peer 已禁用（PI_PEER=0）");

  /**
   * Q-032: 被拒的提问必须说出理由。
   *
   * 用户端只看到「表单没弹出来」：静默 403 让人以为是模型的毛病。这里把理由写进该会话的
   * 聊天区（找得到 token 就定向、找不到就全体广播），同时回 403 给扩展，让它也能把原因
   * 带回给模型。
   */
  const askRefused = async (req: http.IncomingMessage, res: http.ServerResponse, text: string, why: string) => {
    let body: any = null;
    try {
      body = await readBody(req);
    } catch {
      /* 理由不需要请求体，读不到就算了 */
    }
    const session = body?.token ? sessions.byAskToken(String(body.token)) : null;
    log(`ask rejected (${why})${session ? ` for ${session.state.id.slice(0, 8)}` : ""}`);
    if (session) session.notice(text, "warn");
    else broadcast({ type: "notice", text, level: "warn" });
    return json(res, 403, { error: why, text });
  };

  // ---------------------------------------------------------------- http
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const publicReq = isTunnelRequest(req.headers);
    const cookieHeader = req.headers.cookie;
    const ok = authorized(cookieHeader);

    if (url.pathname === "/healthz") {
      return json(res, 200, { ok: true, version: VERSION, pi: piVersion, public: publicReq });
    }

    // Capability-token file serving for previews: no cookie needed (sandboxed iframes have none).
    if (url.pathname.startsWith("/raw/") && serveRaw(req, res, url.pathname)) return;

    // ------------------------------------------------------------ ask-user (loopback only)
    // The `question` / `questionnaire` extensions run inside our pi child; in rpc mode they cannot
    // open a dialog, so they post the question here and we hold the request open until the browser
    // answers. This route sits in front of the cookie gate on purpose (the child has no cookie) and
    // is hostile to the tunnel: public requests, non-loopback peers and unknown tokens all 403.
    if (url.pathname === "/api/ask" && req.method === "POST") {
      // Q-032: 403 不能是哑的 —— 用户看到的只是「表单没弹出来」，无从知道原因。这里把理由
      // 写进该会话的 notice（隧道 + 非回环对端都是同一个理由）。
      if (publicReq) return askRefused(req, res, "你正通过公网隧道访问，浏览器里的表单回不到本机；请用 127.0.0.1 的地址打开再提问。", "tunnel");
      const peer = req.socket.remoteAddress ?? "";
      if (!/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(peer)) return askRefused(req, res, "提问只接受本机回环的请求（扩展与网页必须在这台电脑上）。", "non-loopback");
      let body: any;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: "bad json" });
      }
      // The token is the identity: it resolves to exactly one session, so nothing in the body can
      // claim to be another one.
      const session = sessions.byAskToken(String(body.token ?? ""));
      if (!session) {
        log(`ask rejected: bad token from ${peer}`);
        return json(res, 403, { error: "bad token" });
      }
      const questions = normalizeAskQuestions(body.questions);
      if (!questions.length) return json(res, 400, { error: "no questions" });
      const handle = session.ask(questions, String(body.tool ?? "question"));
      log(`ask ${handle.id} from ${session.state.id.slice(0, 8)} (${questions.length} question(s), ${questions.length > 1 ? "tab" : "single"})`);
      let settled = false;
      // The child hung up (bridge closing it, abort): nobody can answer any more.
      res.on("close", () => {
        if (!settled) session.cancelAsk(handle.id, "发起方断开了");
      });
      const outcome = await handle.outcome;
      settled = true;
      log(`ask ${handle.id} → ${outcome.cancelled ? "cancelled" : `${outcome.answers?.length ?? 0} answer(s)`}`);
      return json(res, 200, outcome);
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      const ip = clientIp(req.headers, req.socket.remoteAddress);
      if (!loginAllowed(ip)) return fail(res, 429, "too_many_attempts", "试太多次了，等一分钟再试");
      const body = await readBody(req).catch(() => ({}));
      if (!verifyPassphrase(String(body.passphrase ?? ""))) {
        log(`login failed from ${ip}`);
        return fail(res, 401, "bad_passphrase", "口令不对");
      }
      resetLoginAttempts(ip);
      log(`login ok from ${ip}${publicReq ? " (tunnel)" : ""}`);
      return json(res, 200, { ok: true }, { "set-cookie": [sessionCookie(issueSessionToken(), publicReq)] });
    }

    // ---------------------------------------------------------------- peer (#45)
    // 页面要 cookie；本机回环不加 cookie 也放行，方便 e2e 与 `/api/peer` 的健康检查。
    // 隧道过来又没 cookie 的请求一律 401，否则 `/api/peer/add` 就能被公网改配置。
    const loopbackPeer = /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(req.socket.remoteAddress ?? "");
    if (url.pathname.startsWith("/api/peer") && !ok && !loopbackPeer) {
      return json(res, 401, { error: "unauthorized" });
    }
    if (url.pathname === "/api/peer") {
      const view = peer.view();
      return json(res, 200, { ...view, enabled: peerOn && view.enabled });
    }
    if (url.pathname === "/api/peer/threads" && req.method === "GET") {
      try {
        return json(res, 200, await peer.threads());
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (url.pathname === "/api/peer/messages" && req.method === "GET") {
      const who = url.searchParams.get("peer") ?? "";
      if (!who) return json(res, 400, { error: "缺 peer" });
      try {
        return json(res, 200, await peer.history(who, Number(url.searchParams.get("limit")) || 200));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (url.pathname === "/api/peer/send" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      try {
        const via = body?.via === "pi" ? ("pi" as const) : undefined;
        return json(res, 200, await peer.sendText(String(body?.peer ?? ""), String(body?.text ?? ""), via));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (url.pathname === "/api/peer/contacts" && req.method === "GET") {
      try {
        return json(res, 200, await peer.contacts());
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (url.pathname === "/api/peer/friend" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      const action = String(body?.action ?? "");
      if (!["request", "accept", "favorite", "remove"].includes(action)) return json(res, 400, { error: "未知动作" });
      try {
        return json(res, 200, await peer.friend(String(body?.peer ?? ""), action as "request", Boolean(body?.on)));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    // 第 4 片：文件。路径版直接让 peer 读盘；字节版给剪贴板截图用。
    if (url.pathname === "/api/peer/sendfile" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      try {
        return json(res, 200, await peer.sendFile(String(body?.peer ?? ""), String(body?.path ?? ""), body?.name ? String(body.name) : undefined));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (url.pathname === "/api/peer/upload" && req.method === "POST") {
      const raw = await readRaw(req, 64 * 1024 * 1024).catch(() => null);
      if (!raw) return json(res, 413, { error: "太大了（上限 64 MB）" });
      try {
        return json(res, 200, await peer.upload(url.searchParams.get("peer") ?? "", url.searchParams.get("name") || "粘贴的图片.png", raw));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (url.pathname === "/api/peer/transfers" && req.method === "GET") {
      try {
        return json(res, 200, await peer.transfers());
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (url.pathname === "/api/peer/fs" && req.method === "GET") {
      try {
        return json(res, 200, await peer.browse(url.searchParams.get("path") ?? ""));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (url.pathname === "/api/peer/file" && req.method === "GET") {
      try {
        const upstream = await peer.fileStream(url.searchParams.get("id") ?? "");
        if (!upstream.ok || !upstream.body) return json(res, upstream.status, { error: "取不到这个文件" });
        const headers: Record<string, string> = { "cache-control": "private, max-age=60" };
        for (const key of ["content-type", "content-length", "content-disposition"]) {
          const value = upstream.headers.get(key);
          if (value) headers[key] = value;
        }
        res.writeHead(200, headers);
        Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
        return;
      } catch (err) {
        return json(res, 404, { error: (err as Error).message });
      }
    }
    if (url.pathname === "/api/peer/add" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      try {
        return json(res, 200, await peer.addManual(String(body?.addr ?? "")));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (url.pathname === "/api/peer/refresh" && req.method === "POST") {
      try {
        return json(res, 200, await peer.refresh());
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }

    if (url.pathname === "/api/logout" && req.method === "POST") {
      return json(res, 200, { ok: true }, { "set-cookie": [clearedCookie(publicReq)] });
    }

    if (!ok) {
      if (!url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname); // let the SPA show the login form
      return json(res, 401, { error: "unauthorized" });
    }

    if (url.pathname === "/api/me") {
      return json(res, 200, {
        version: VERSION,
        pi: piVersion,
        public: publicReq,
        passphrase: currentPassphrase() ? null : "",
        tunnel: tunnel.state,
        pushKey: notifier.vapidPublicKey,
        pushCount: notifier.subscriptionCount(),
        notify: notifier.enabled,
        sessionsRoot: sessionsRootInfo().dir,
        sessionsRootSource: sessionsRootInfo().source,
      });
    }

    // Folder picker for new sessions: the browser cannot see this machine's absolute paths.
    // D62: `stats=1` answers file sizes/mtimes for the same directory, so the rows can paint first.
    if (url.pathname === "/api/dirs" && req.method === "GET") {
      const dir = url.searchParams.get("path") ?? "";
      if (url.searchParams.get("stats") === "1") return json(res, 200, { files: statFiles(dir) });
      return json(res, 200, listDirs(dir, url.searchParams.get("files") === "1"));
    }

    // Q-021: the branch under the composer. A branch name is this machine's working state, so a
    // tunnel visitor neither needs it nor may have it (same call as /api/clipboard-files).
    if (url.pathname === "/api/git" && req.method === "GET") {
      if (publicReq) return json(res, 200, { repo: null });
      const dir = (url.searchParams.get("dir") ?? "").trim();
      if (!dir) return fail(res, 400, "dir_empty", "dir 不能为空", undefined, { repo: null });
      if (!path.isAbsolute(dir)) return fail(res, 400, "dir_not_absolute", "dir 必须是绝对路径", undefined, { repo: null });
      try {
        const info = await gitInfo(dir, url.searchParams.get("fresh") === "1");
        return json(res, 200, info ?? { repo: null });
      } catch (err: any) {
        // A missing git, a corrupt repo, a timeout: the line just keeps its key hints.
        return json(res, 200, { repo: null, error: String(err?.message ?? err).slice(0, 200) });
      }
    }

    // Ctrl+V of a file copied in Explorer: the page gets bytes only, so read the real path here.
    // Over the tunnel this machine's clipboard is not the visitor's, so refuse.
    if (url.pathname === "/api/clipboard-files" && req.method === "GET") {
      if (publicReq) return fail(res, 403, "clipboard_public", "通过公网访问时读不到你电脑的剪贴板");
      try {
        return json(res, 200, { paths: await clipboardFiles() });
      } catch (err: any) {
        return fail(res, 500, "clipboard_read_failed", `读不了剪贴板：${String(err?.message ?? err).slice(0, 200)}`);
      }
    }

    // An image picked in the file browser gets attached, not referenced by path.
    if (url.pathname === "/api/image" && req.method === "GET") {
      try {
        const img = readAttachableImage(url.searchParams.get("path") ?? "");
        res.writeHead(200, { "content-type": img.mime, "content-length": String(img.data.length), "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end(img.data);
        return;
      } catch (err: any) {
        return json(res, 400, { error: String(err?.message ?? err) });
      }
    }

    if (url.pathname === "/api/preview" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      const sessionId = String(body.sessionId ?? "");
      const where = sessions.locate(sessionId);
      if (!where) return fail(res, 404, "session_not_found", "找不到这个会话");
      try {
        const info = openPreview(where, String(body.path ?? ""));
        // Text files opened here become writable for this session (D50).
        rememberEditable(sessionId, info);
        return json(res, 200, info);
      } catch (err: any) {
        return json(res, 400, { error: String(err?.message ?? err) });
      }
    }

    // The file explorer's save: only paths /api/preview handed out as text may be written.
    if (url.pathname === "/api/save" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      const sessionId = String(body.sessionId ?? "");
      if (!sessions.locate(sessionId)) return fail(res, 404, "session_not_found", "找不到这个会话");
      try {
        const out = savePreviewFile(sessionId, body);
        log(`save ${out.path} (${out.size} bytes) from ${sessionId.slice(0, 8)}`);
        return json(res, 200, out);
      } catch (err: any) {
        const status = Number(err?.status) || 400;
        return json(res, status, { error: String(err?.message ?? err) });
      }
    }

    // D69: reveal a file in the desktop's own file manager. Same trust level as /api/preview (any
    // logged-in page may ask — it can already read the whole disk), but it *acts* on the desktop, so a
    // tunnel visitor is refused outright instead of getting a step-up prompt for it.
    if (url.pathname === "/api/reveal" && req.method === "POST") {
      if (publicReq) return fail(res, 403, "reveal_public", "通过公网访问时不会在你的桌面上打开文件夹，回本机操作");
      const body = await readBody(req).catch(() => ({}));
      const out = revealInFileManager(String(body.path ?? ""));
      log(`reveal ${String(body.path ?? "")} → ${out.ok ? "ok" : out.message}`);
      // Errors carry `{error}` like every other route — api.ts's error path reads that field.
      return out.ok ? json(res, 200, out) : json(res, 400, { error: out.message });
    }

    if (url.pathname === "/api/sessions") {
      return json(res, 200, { sessions: sessions.list(), tunnel: tunnel.state });
    }

    if (url.pathname === "/api/session" && req.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return json(res, 400, { error: "id required" });
      try {
        return json(res, 200, sessions.snapshot(id));
      } catch (err: any) {
        return json(res, 404, { error: String(err?.message ?? err) });
      }
    }

    // #24 `/export`: the session as pi's own self-contained HTML (`pi --export`, opened in a tab), or the
    // raw JSONL file as a download. Read-only on the session file; works whether or not it is live.
    if (url.pathname === "/api/export" && req.method === "GET") {
      const id = url.searchParams.get("id") ?? "";
      const format = url.searchParams.get("format") === "jsonl" ? "jsonl" : "html";
      const where = id ? sessions.locate(id) : null;
      if (!where?.file || !fs.existsSync(where.file)) return fail(res, 404, "session_no_file", "这个会话还没有写到磁盘（发过一条消息之后才有文件）");
      const base = (sessions.get(id)?.state.name || path.basename(where.file, ".jsonl")).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 80) || "session";
      const disposition = (name: string, inline: boolean) => `${inline ? "inline" : "attachment"}; filename="session.${name.split(".").pop()}"; filename*=UTF-8''${encodeURIComponent(name)}`;
      if (format === "jsonl") {
        res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "content-disposition": disposition(`${base}.jsonl`, false) });
        fs.createReadStream(where.file).pipe(res);
        return;
      }
      const out = statePath("exports", `${id}.html`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const child = spawn(process.execPath, [pi.cli, "--export", where.file, out], { cwd: os.homedir(), stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let err = "";
      child.stderr.on("data", (b) => (err = (err + String(b)).slice(-2000)));
      const timer = setTimeout(() => child.kill(), 60_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 || !fs.existsSync(out)) return fail(res, 500, "export_failed", `pi --export 失败（exit ${code}）：${err.trim()}`, { p1: code ?? -1 });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-disposition": disposition(`${base}.html`, url.searchParams.get("download") !== "1") });
        fs.createReadStream(out).pipe(res);
      });
      return;
    }

    // `/changelog` (#26): what is new in the installed pi.
    if (url.pathname === "/api/changelog" && req.method === "GET") {
      return json(res, 200, { version: piVersion, text: changelog(pi.cli) });
    }

    // #25 `@` in the composer: fuzzy file search under the session's cwd (relative paths).
    if (url.pathname === "/api/files" && req.method === "GET") {
      const where = sessions.locate(url.searchParams.get("id") ?? "");
      const cwd = where?.cwd ?? "";
      try {
        if (!cwd || !fs.statSync(cwd).isDirectory()) return fail(res, 404, "cwd_missing", "会话的工作目录不存在", undefined, { files: [] });
      } catch {
        return fail(res, 404, "cwd_missing", "会话的工作目录不存在", undefined, { files: [] });
      }
      const files = rankFiles(await listFiles(cwd), url.searchParams.get("q") ?? "");
      return json(res, 200, { cwd, files });
    }

    // #38: a bug report exported as zip, downloaded once it is written.
    if (url.pathname === "/api/bugzip" && req.method === "GET") {
      const name = url.searchParams.get("name") ?? "";
      const file = statePath("bug-reports", name);
      if (!/^pi-bug-report-[\w-]+\.zip$/.test(name) || !fs.existsSync(file)) return fail(res, 404, "report_not_found", "没有这个报告");
      res.writeHead(200, { "content-type": "application/zip", "cache-control": "no-store", "content-disposition": `attachment; filename="${name}"` });
      fs.createReadStream(file).pipe(res);
      return;
    }

    // Diagnostics (#24, the web stand-in for `/debug`): this session's pi stderr log kept by the bridge.
    if (url.pathname === "/api/log" && req.method === "GET") {
      const id = url.searchParams.get("id") ?? "";
      const file = statePath("logs", `${id.replace(/[^\w.-]/g, "")}.log`);
      if (!id || !fs.existsSync(file)) return fail(res, 404, "no_process_log", "这个会话还没有 pi 进程日志（网页接管过才会有）");
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
      const body = await readBody(req).catch(() => null);
      if (!body?.endpoint || !body?.keys?.p256dh) return json(res, 400, { error: "bad subscription" });
      notifier.addSubscription({ endpoint: body.endpoint, keys: body.keys, createdAt: Date.now(), label: body.label });
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/tunnel" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      if (body.action === "start") {
        if (!tunnelBin) return fail(res, 400, "cloudflared_missing", "没找到 cloudflared");
        tunnel.start();
      } else if (body.action === "stop") {
        tunnel.stop();
      }
      return json(res, 200, { tunnel: tunnel.state });
    }

    if (url.pathname === "/api/notify-test" && req.method === "POST") {
      const test =
        uiLang === "en"
          ? { title: "pi-web-client test", body: "If you can read this, push notifications work." }
          : uiLang === "ja"
            ? { title: "pi-web-client テスト", body: "これが見えていれば、通知は届いています。" }
            : { title: "pi-web-client 测试", body: "如果你看到这条，通知链路是通的。" };
      const result = await notifier.notify(test.title, test.body, `${publicReq ? tunnel.state.url ?? "" : "http://127.0.0.1:" + cfg.port}`, true);
      return json(res, 200, result);
    }

    if (!url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname);
    return json(res, 404, { error: "not found" });
  });

  // ---------------------------------------------------------------- websocket
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/ws")) {
      socket.destroy();
      return;
    }
    if (!authorized(req.headers.cookie)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as any).publicReq = isTunnelRequest(req.headers);
      (ws as any).stepUntil = (ws as any).publicReq ? 0 : Number.MAX_SAFE_INTEGER;
      wss.emit("connection", ws, req);
    });
  });

  const broadcast = (payload: any) => {
    const data = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  };

  // Terminals live in the bridge, not in a connection: a page reload re-attaches and replays output.
  const terminals = new Terminals({
    onData: (id, data) => broadcast({ type: "term.data", id, data }),
    onExit: (id, code) => broadcast({ type: "term.exit", id, code }),
  });

  sessions.on("ws", broadcast);
  /**
   * D120: the panel stays live without a timer of its own, but only pages that actually asked for
   * the numbers get the tick's broadcast — a 60 s push to every idle tab is nobody's feature.
   */
  const broadcastRuntime = (stats: object) => {
    const data = JSON.stringify({ type: "runtime.stats", ...stats });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && (client as any).wantsRuntime) client.send(data);
    }
  };
  sessions.on("runtime", broadcastRuntime);
  /**
   * D91: no Windows / WeChat ping while somebody is looking at a page (visible tab in a focused
   * window); the page reports that over its socket. The service worker checks again on arrival.
   */
  /**
   * D110：推送标题跟界面语言。页面连上 WS 时上报一次（`{type:"lang"}`），这里只留最近一个值，
   * 不落盘 —— bridge 重启就回落中文。正文（审批描述、问题原文）是 pi 产出的，不翻译。
   */
  let uiLang: "zh-Hans" | "en" | "ja" = "zh-Hans";
  const notifyTitle = (kind: "approval" | "ask", name: string, count: number): string => {
    if (uiLang === "en") return kind === "approval" ? `Approval needed · ${name}` : `Answer needed${count > 1 ? ` (${count} questions)` : ""} · ${name}`;
    if (uiLang === "ja") return kind === "approval" ? `承認が必要です · ${name}` : `回答が必要です${count > 1 ? `（${count} 問）` : ""} · ${name}`;
    return kind === "approval" ? `需要你批准 · ${name}` : `需要你回答${count > 1 ? `（${count} 题）` : ""} · ${name}`;
  };
  const shouldNotify = (): boolean => notifier.enabled && !anyPresent();
  sessions.on("approval", (approval) => {
    if (!shouldNotify()) return;
    const session = sessions.get(approval.sessionId);
    const name = session?.state.name ?? approval.sessionId.slice(0, 8);
    const body = approval.message.replace(/\s+/g, " ").slice(0, 140);
    const link = tunnel.state.url ? `${tunnel.state.url}/#/s/${approval.sessionId}` : `http://127.0.0.1:${cfg.port}/#/s/${approval.sessionId}`;
    void notifier.notify(notifyTitle("approval", name, 1), body, link);
  });
  sessions.on("ask", (ask, tool) => {
    const session = sessions.get(ask.sessionId);
    const name = session?.state.name ?? ask.sessionId.slice(0, 8);
    const first = ask.questions[0];
    const body = (first?.prompt ?? "").replace(/\s+/g, " ").slice(0, 140);
    const link = tunnel.state.url ? `${tunnel.state.url}/#/s/${ask.sessionId}` : `http://127.0.0.1:${cfg.port}/#/s/${ask.sessionId}`;
    if (!shouldNotify()) {
      log(`ask-push skipped ${String(tool)} ${ask.id} (${notifier.enabled ? "page in front" : "notifications off"})`);
      return;
    }
    void notifier.notify(notifyTitle("ask", name, ask.questions.length), body, link);
    log(`ask-push ${String(tool)} ${ask.id} → ${name}`);
  });
  tunnel.on("state", (state) => {
    broadcast({ type: "tunnel", tunnel: state });
    log(`tunnel ${state.status} ${state.url ?? ""} ${state.error ?? ""}`);
  });

  wss.on("connection", (ws, req) => {
    const send = (payload: any) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };
    send({
      type: "hello",
      version: VERSION,
      pi: piVersion,
      sessions: sessions.list(),
      manage: sessions.manage.snapshot(),
      trash: sessions.trashList(),
      tunnel: tunnel.state,
      public: (ws as any).publicReq,
      ui: readUiPrefs(),
      notes: listNotes(),
    });
    // The model catalog needs a throwaway pi child (~1s), so it follows the handshake.
    void sessions
      .models()
      .then((models) => send({ type: "catalog", models }))
      .catch(() => send({ type: "catalog", models: [] }));
    log(`ws connected from ${clientIp(req.headers, req.socket.remoteAddress)}${(ws as any).publicReq ? " (tunnel)" : ""}`);

    const requireStepUp = async (): Promise<boolean> => {
      if (Date.now() < (ws as any).stepUntil) return true;
      send({ type: "need-stepup" });
      return false;
    };

    // A login waiting on this page's answers (or an OAuth callback server) must not outlive it.
    ws.on("close", () => {
      dropClient(ws);
      for (const id of ((ws as any).logins ?? []) as string[]) cancelLogin(id);
    });

    ws.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        switch (msg.type) {
          case "presence": {
            reportPresence(ws, msg.active === true);
            return;
          }
          case "lang": {
            // 只有推送标题用得上，别的什么都不用动，所以不需要 step-up。
            if (msg.lang === "zh-Hans" || msg.lang === "en" || msg.lang === "ja") uiLang = msg.lang;
            return;
          }
          case "notify.set": {
            if (!(await requireStepUp())) return;
            notifier.setEnabled(msg.on === true);
            log(`notifications ${notifier.enabled ? "on" : "off"}`);
            broadcast({ type: "notify", on: notifier.enabled });
            return;
          }
          case "stepup": {
            const ip = clientIp(req.headers, req.socket.remoteAddress);
            if (!loginAllowed(ip)) {
              send({ type: "notice", code: "too_many_attempts", text: "试太多次了，等一分钟再试", level: "error" });
              return;
            }
            if (!verifyPassphrase(String(msg.passphrase ?? ""))) {
              log(`stepup failed from ${ip}`);
              send({ type: "notice", code: "bad_passphrase", text: "口令不对", level: "error" });
              return;
            }
            resetLoginAttempts(ip);
            (ws as any).stepUntil = Date.now() + STEP_UP_MS;
            send({ type: "stepup-ok", until: (ws as any).stepUntil });
            return;
          }
          case "models": {
            send({ type: "catalog", models: await sessions.models(true).catch(() => []) });
            return;
          }
          // ---------------------------------------------------------------- terminals (Q-007/Q-008)
          case "term.open": {
            if ((ws as any).publicReq) {
              send({ type: "term.error", message: "终端只对本机 / 局域网开放：走公网隧道时禁用" });
              return;
            }
            if (!(await requireStepUp())) return;
            const opened = terminals.open({
              cols: Number(msg.cols),
              rows: Number(msg.rows),
              cwd: msg.cwd ? String(msg.cwd) : undefined,
              shell: msg.shell ? String(msg.shell) : undefined,
            });
            if ("error" in opened) {
              send({ type: "term.error", message: opened.error });
              return;
            }
            broadcast({ type: "term.opened", ...opened });
            log(`terminal ${opened.id} opened (${opened.shell}) in ${opened.cwd}`);
            return;
          }
          case "term.attach": {
            const id = String(msg.id ?? "");
            const history = terminals.history(id);
            const meta = terminals.describe(id);
            if (history === null || !meta) send({ type: "term.gone", id });
            else send({ type: "term.replay", id, data: history, ...meta });
            return;
          }
          case "term.input": {
            if ((ws as any).publicReq) return;
            terminals.write(String(msg.id ?? ""), String(msg.data ?? ""));
            return;
          }
          case "term.resize": {
            terminals.resize(String(msg.id ?? ""), Number(msg.cols), Number(msg.rows));
            return;
          }
          case "term.close": {
            terminals.close(String(msg.id ?? ""));
            return;
          }
          case "term.list": {
            send({ type: "term.list", items: terminals.list(), shells: terminals.shells() });
            return;
          }
          case "term.elevate":
          case "open.script": {
            if ((ws as any).publicReq) {
              send({ type: "notice", code: "window_public", text: "公网访问时不能在你电脑上开窗口", level: "error" });
              return;
            }
            if (!(await requireStepUp())) return;
            const res = openConsole({
              cwd: msg.cwd ? String(msg.cwd) : undefined,
              file: msg.type === "open.script" ? String(msg.file ?? "") : undefined,
              admin: Boolean(msg.admin),
            });
            log(`${msg.type}${msg.admin ? " (admin)" : ""}: ${res.message}`);
            send({ type: "notice", text: res.message, level: res.ok ? "info" : "error" });
            return;
          }
          case "subscribe": {
            const snap = sessions.snapshot(msg.sessionId);
            (ws as any).watching = String(msg.sessionId);
            send({ type: "session", sessionId: msg.sessionId, ...snap, trust: await trustFor(snap.state.cwd) });
            return;
          }
          case "claim": {
            if (!(await requireStepUp())) return;
            const session = await sessions.claim(String(msg.sessionId));
            (ws as any).watching = session.state.id;
            send({ type: "session", sessionId: session.state.id, ...session.snapshot(), trust: await trustFor(session.state.cwd) });
            return;
          }
          case "prompt": {
            if (!(await requireStepUp())) return;
            const session = await sessions.openLive(msg.sessionId);
            await session.prompt(
              String(msg.text ?? ""),
              msg.images,
              typeof msg.clientId === "string" ? msg.clientId.slice(0, 80) : undefined,
              msg.behavior === "followUp" ? "followUp" : "steer",
            );
            return;
          }
          case "bash": {
            // `!cmd` / `!!cmd` from the composer (#16): runs through pi so the output joins the context.
            if (!(await requireStepUp())) return;
            const command = String(msg.command ?? "").trim();
            if (!command) return;
            const session = await sessions.openLive(msg.sessionId);
            await session.bash(command, msg.excludeFromContext === true);
            return;
          }
          case "abortBash": {
            if (!(await requireStepUp())) return;
            sessions.get(msg.sessionId)?.abortBash();
            return;
          }
          case "tree": {
            // #17: read from the session file, so read-only sessions have a tree too.
            const sessionId = String(msg.sessionId ?? "");
            send({ type: "tree", sessionId, ...sessions.tree(sessionId) });
            return;
          }
          case "fork":
          case "clone": {
            if (!(await requireStepUp())) return;
            const sessionId = String(msg.sessionId ?? "");
            const reqId = String(msg.reqId ?? "");
            try {
              const out = await sessions.branchOff(
                sessionId,
                msg.type === "clone"
                  ? "clone"
                  : {
                      entryId: typeof msg.entryId === "string" ? msg.entryId : undefined,
                      index: Number.isInteger(msg.index) ? msg.index : undefined,
                      text: typeof msg.text === "string" ? msg.text : undefined,
                    },
              );
              log(`${msg.type} ${sessionId} → ${out.sessionId}`);
              send({ type: "branch.result", reqId, from: sessionId, ...out });
            } catch (err: any) {
              send({ type: "branch.result", reqId, from: sessionId, error: String(err?.message ?? err) });
            }
            return;
          }
          case "import": {
            if (!(await requireStepUp())) return;
            try {
              const out = sessions.importFile(String(msg.path ?? ""));
              send({ type: "import.result", ...out });
            } catch (err: any) {
              send({ type: "import.result", error: String(err?.message ?? err) });
            }
            return;
          }
          case "clearQueue": {
            // The queue bar's 撤回: pi's queue back into the editor, like Alt+Up in the terminal (#14).
            if (!(await requireStepUp())) return;
            await sessions.get(msg.sessionId)?.withdrawQueue();
            return;
          }
          case "create": {
            if (!(await requireStepUp())) return;
            const name = typeof msg.name === "string" && msg.name.trim() ? msg.name.trim().slice(0, 120) : undefined;
            // #28: CLI flags for this session, validated before anything is spawned.
            const launch = cleanLaunch(msg.options);
            const session = await sessions.create(String(msg.cwd || process.cwd()), name, launch);
            // Q-022: created from the pin strip's ＋ → pinned at the end of the strip, and every
            // client hears about the arrangement (the strip is a projection of manage.pin).
            if (msg.pin) sessions.pinLast(session.state.id);
            (ws as any).watching = session.state.id;
            send({ type: "session", sessionId: session.state.id, ...session.snapshot(), trust: await trustFor(session.state.cwd) });
            broadcast({ type: "session.state", session: session.state });
            if (msg.pin) broadcast({ type: "manage", manage: sessions.manage.snapshot() });
            return;
          }
          case "mkdir": {
            // New-session folder picker: one level, under a folder the user is browsing.
            if (!(await requireStepUp())) return;
            const reqId = String(msg.reqId ?? "");
            try {
              const created = makeDir(String(msg.parent ?? ""), String(msg.name ?? ""));
              log(`mkdir ${created}`);
              send({ type: "mkdir.result", reqId, path: created });
            } catch (err: any) {
              send({ type: "mkdir.result", reqId, error: String(err?.message ?? err) });
            }
            return;
          }
          case "abort": {
            if (!(await requireStepUp())) return;
            sessions.get(msg.sessionId)?.abort();
            return;
          }
          case "compact": {
            if (!(await requireStepUp())) return;
            const instructions = typeof msg.instructions === "string" && msg.instructions.trim() ? msg.instructions.trim().slice(0, 4000) : undefined;
            await sessions.get(msg.sessionId)?.compact(instructions);
            return;
          }
          case "answer": {
            if (!(await requireStepUp())) return;
            const answers = Array.isArray(msg.answers) ? (msg.answers as AskAnswer[]) : [];
            if (msg.cancelled) sessions.cancelAsk(msg.sessionId, msg.askId, "用户在网页上取消了");
            else sessions.answerAsk(msg.sessionId, msg.askId, answers);
            return;
          }
          case "approve": {
            if (!(await requireStepUp())) return;
            sessions.respond(msg.sessionId, msg.approvalId, msg.decision);
            return;
          }
          case "setModel": {
            if (!(await requireStepUp())) return;
            const live = sessions.get(msg.sessionId);
            await live?.setModel(msg.provider, msg.modelId);
            // Confirmed together in the model sheet: apply the level after the switch, which may clamp it.
            if (live && typeof msg.level === "string" && msg.level) await live.setThinking(msg.level);
            return;
          }
          case "setThinking": {
            if (!(await requireStepUp())) return;
            await sessions.get(msg.sessionId)?.setThinking(String(msg.level));
            return;
          }
          case "setPermission": {
            if (!(await requireStepUp())) return;
            if (!isPermissionMode(msg.mode)) return;
            sessions.setPermission(String(msg.sessionId ?? ""), msg.mode);
            return;
          }
          case "setBudget": {
            if (!(await requireStepUp())) return;
            const raw = Number(msg.budget);
            sessions.get(msg.sessionId)?.setContextBudget(Number.isFinite(raw) && raw > 0 ? raw : null);
            return;
          }
          case "skills": {
            const list = await sessions.skillsFor(String(msg.sessionId ?? ""), msg.cwd ? String(msg.cwd) : undefined);
            send({ type: "skills", sessionId: msg.sessionId ?? null, commands: list });
            return;
          }
          // ------------------------------------------------ settings / trust / reload (#26 #21)
          case "settings.get": {
            const scope = msg.scope === "project" ? "project" : "global";
            const cwd = scope === "project" ? String(msg.cwd ?? "") || null : null;
            send({ type: "settings", ...(await readSettings(pi.cli, scope, cwd)) });
            return;
          }
          case "settings.set": {
            if (!(await requireStepUp())) return;
            const scope = msg.scope === "project" ? "project" : "global";
            const cwd = scope === "project" ? String(msg.cwd ?? "") || null : null;
            try {
              const view = await writeSettings(pi.cli, scope, cwd, {
                patch: msg.patch && typeof msg.patch === "object" && !Array.isArray(msg.patch) ? msg.patch : undefined,
                raw: typeof msg.raw === "string" ? msg.raw : undefined,
              });
              log(`settings ${scope} written: ${view.path}`);
              send({ type: "settings", ...view, saved: true });
            } catch (err: any) {
              send({ type: "settings.error", scope, message: String(err?.message ?? err) });
            }
            return;
          }
          case "runtime": {
            if (!(await requireStepUp())) return;
            const session = sessions.get(String(msg.sessionId ?? ""));
            const done = session ? await session.applyRuntime(msg) : [];
            if (done.length) send({ type: "notice", sessionId: msg.sessionId, text: `已应用到当前会话：${done.join("、")}`, level: "info" });
            return;
          }
          // D120 / #77: read-only numbers for the runtime panel. Nothing here changes a session.
          case "runtime.stats": {
            (ws as any).wantsRuntime = true;
            send({ type: "runtime.stats", ...(await sessions.runtimeStats()) });
            return;
          }
          // D120 / #80: the manual way out when memory is needed now. Only idle sessions sleep; a run
          // in flight is named in the receipt instead of being interrupted.
          case "runtime.sleepAll": {
            const receipt = await sessions.sleepAll();
            send({ type: "runtime.sleepAll", ...receipt });
            // The page must see the number drop now, not on the next 60 s tick.
            broadcastRuntime(await sessions.runtimeStats());
            return;
          }
          case "reload": {
            if (!(await requireStepUp())) return;
            const session = await sessions.reload(String(msg.sessionId ?? ""));
            (ws as any).watching = session.state.id;
            send({ type: "session", sessionId: session.state.id, ...session.snapshot(), trust: await trustFor(session.state.cwd) });
            send({ type: "notice", sessionId: session.state.id, text: "已重新加载：pi 进程重启，设置、扩展、技能、模板、AGENTS.md 都是最新的了。", level: "info" });
            return;
          }
          case "picli": {
            // #33: pi install / remove / update / list, pi mcp list / add / remove / login / logout.
            const op = String(msg.op ?? "");
            // D113: the page correlates every event with the button that started it, so several
            // operations can be in flight (queued) at once.
            const reqId = typeof msg.reqId === "string" ? msg.reqId.slice(0, 60) : null;
            // D81: from the public tunnel the extension manager is read-only.
            if (isWriteOp(op) && (ws as any).publicReq) {
              send({ type: "picli.done", reqId, runId: null, op, code: -1, error: "通过公网访问时扩展与 MCP 只能查看，安装 / 卸载 / 更新请在本机或局域网操作", errCode: "picli_public" });
              return;
            }
            if (isWriteOp(op) && !(await requireStepUp())) {
              send({ type: "picli.done", reqId, runId: null, op, code: -1, error: "要重新输入口令才能改扩展", errCode: "stepup_required" });
              return;
            }
            const runId = `cli_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
            const exec = async (): Promise<{ code: number | null; data?: unknown; error?: string }> => {
              let run: ReturnType<typeof runPiCli>;
              try {
                run = runPiCli(pi.cli, msg, (chunk) => send({ type: "picli.out", runId, text: chunk }));
              } catch (err: any) {
                return { code: -1, error: String(err?.message ?? err) };
              }
              // Sent here, not before the queue: the page shows 「排队中」 until its own command starts.
              send({ type: "picli.start", reqId, runId, op });
              const out = await run.done;
              return { code: out.code, data: out.data };
            };
            if (isWriteOp(op)) log(`pi ${op} ${JSON.stringify({ ...msg, type: undefined, reqId: undefined }).slice(0, 200)}`);
            // D113: installs / removals / updates share one npm prefix and each rewrites the whole
            // package list, so they take the `npm` lock and run one at a time; the page stays clickable.
            // `pi mcp add/remove` also rewrite an mcp.json, which the toggle buttons edit too.
            const fileKey = op === "mcp.add" || op === "mcp.remove" ? mcpFileLock(msg.local === true, typeof msg.cwd === "string" ? msg.cwd : null) : null;
            const out = isWriteOp(op) ? await writeLock("npm", () => (fileKey ? writeLock(fileKey, exec) : exec())) : await exec();
            if (out.error) {
              send({ type: "picli.done", reqId, runId, op, code: out.code, error: out.error });
              return;
            }
            send({ type: "picli.done", reqId, runId, op, code: out.code, data: out.data });
            // #49: a successful self-update replaced the package under us; re-read its version so the
            // page's 「pi x.y.z」 stops lying without a bridge restart (running sessions keep the old code).
            if (out.code === 0 && op === "pkg.update") {
              const target = msg.target === undefined ? "self" : String(msg.target);
              if (target === "self" || target === "all") {
                const from = piVersion;
                piVersion = readVersion(pi.cli);
                if (piVersion !== from) broadcast({ type: "pi.version", version: piVersion, previous: from });
              }
            }
            // A new package can bring providers, skills or extensions: refresh what the page lists.
            if (isWriteOp(op) && op.startsWith("pkg.")) broadcast({ type: "catalog", models: await sessions.models(true).catch(() => []) });
            return;
          }
          case "pi.update.check": {
            // #49: read-only, so the tunnel may ask too; `force` is the row's 重新检查.
            try {
              const latest = await piLatest(msg.force === true);
              send({ type: "pi.update.status", current: piVersion, latest: latest.latest, source: latest.source, checkedAt: latest.checkedAt, update: newer(latest.latest, piVersion) });
            } catch (err: any) {
              send({ type: "pi.update.status", current: piVersion, latest: null, checkedAt: Date.now(), error: String(err?.message ?? err) });
            }
            return;
          }
          // ------------------------------------------------ 扩展 manager (D81)
          case "ui.set": {
            if (!(await requireStepUp())) return;
            const prefs = writeUiPrefs({ ...(typeof msg.showExtButton === "boolean" ? { showExtButton: msg.showExtButton } : {}) });
            broadcast({ type: "ui", ui: prefs });
            return;
          }
          case "ext.inventory": {
            const cwd = msg.cwd ? String(msg.cwd) : null;
            try {
              // D113: pushed in stages (`local` → `mcp` → `versions`), so the page can paint the
              // installed rows before the slow MCP connections and the registry lookups finish.
              const inv = await inventory(pi.cli, cwd, msg.check !== false, (partial) => send({ type: "ext.inventory", cwd, ...partial }));
              broadcast({ type: "ext.updates", count: inv.updates });
            } catch (err: any) {
              send({ type: "ext.inventory", cwd, error: String(err?.message ?? err) });
            }
            return;
          }
          case "ext.updates": {
            const cwd = msg.cwd ? String(msg.cwd) : null;
            send({ type: "ext.updates", count: await updateCount(pi.cli, cwd).catch(() => 0) });
            return;
          }
          case "ext.store": {
            const limit = Math.min(100, Math.max(1, Number(msg.limit) || 20));
            try {
              send({ type: "ext.store", query: String(msg.query ?? ""), items: await searchPackages(String(msg.query ?? ""), limit) });
            } catch (err: any) {
              send({ type: "ext.store", query: String(msg.query ?? ""), items: [], error: `查不到 npm：${err?.message ?? err}`, errCode: "npm_lookup_failed" });
            }
            return;
          }
          case "mcp.store": {
            const limit = Math.min(100, Math.max(1, Number(msg.limit) || 20));
            try {
              send({ type: "mcp.store", query: String(msg.query ?? ""), ...(await searchMcp(String(msg.query ?? ""), limit)) });
            } catch (err: any) {
              send({ type: "mcp.store", query: String(msg.query ?? ""), items: [], error: `查不到 MCP Registry：${err?.message ?? err}`, errCode: "registry_lookup_failed" });
            }
            return;
          }
          case "ext.toggle":
          case "mcp.toggle":
          case "mcp.bump":
          case "mcp.install": {
            const op = String(msg.type ?? "");
            // D113: each write reports queued / running / done for *its own* button, and takes the lock
            // of the resource it touches, so the rest of the manager stays clickable.
            const reqId = typeof msg.reqId === "string" ? msg.reqId.slice(0, 60) : null;
            const fail = (err: unknown) => {
              const text = String((err as any)?.message ?? err);
              send({ type: "notice", text, level: "error" });
              send({ type: "ext.error", message: text });
              send({ type: "ext.op", reqId, op, state: "done", code: -1, error: text });
            };
            if ((ws as any).publicReq) {
              send({ type: "notice", text: "通过公网访问时扩展与 MCP 只能查看", level: "warn" });
              send({ type: "ext.op", reqId, op, state: "done", code: -1, error: "公网只读", errCode: "picli_public" });
              return;
            }
            if (!(await requireStepUp())) {
              send({ type: "ext.op", reqId, op, state: "done", code: -1, error: "要重新输入口令才能改扩展", errCode: "stepup_required" });
              return;
            }
            if (msg.type !== "mcp.install") send({ type: "ext.op", reqId, op, state: "running" });
            try {
              if (msg.type === "ext.toggle") {
                const scope = msg.scope === "project" ? "project" : msg.scope === "builtin" ? "builtin" : "user";
                // Built-ins live in the *global* settings.json, exactly like user extensions
                // (toggleExtension maps them there), so the lock is named after the file, not the scope.
                await writeLock(`settings:${scope === "project" ? "project" : "global"}`, () =>
                  toggleExtension(pi.cli, { id: String(msg.id ?? ""), scope, how: String(msg.how ?? "") }, msg.enable === true, msg.cwd ? String(msg.cwd) : null),
                );
                send({ type: "ext.changed", what: "extension", id: msg.id });
              } else if (msg.type === "mcp.toggle") {
                const file = String(msg.file ?? "");
                await writeLock(`mcp:${file}`, async () => toggleMcp(file, String(msg.name ?? ""), msg.enable === true));
                send({ type: "ext.changed", what: "mcp", id: msg.name });
              } else if (msg.type === "mcp.bump") {
                const file = String(msg.file ?? "");
                await writeLock(`mcp:${file}`, async () => bumpMcp(file, String(msg.name ?? ""), String(msg.version ?? "")));
                send({ type: "ext.changed", what: "mcp", id: msg.name });
              } else {
                const { req, vars } = mcpAddRequest(msg.option as McpInstallOption, {
                  name: String(msg.name ?? ""),
                  values: msg.values && typeof msg.values === "object" ? msg.values : {},
                  local: msg.local === true,
                  exposure: typeof msg.exposure === "string" ? msg.exposure : undefined,
                  description: typeof msg.description === "string" ? msg.description : undefined,
                });
                const runId = `cli_${Date.now().toString(36)}`;
                const out = await writeLock("npm", () =>
                  writeLock(mcpFileLock(msg.local === true, typeof msg.cwd === "string" ? msg.cwd : null), async () => {
                    send({ type: "picli.start", reqId, runId, op: "mcp.add" });
                    return runPiCli(pi.cli, { ...req, cwd: msg.cwd ? String(msg.cwd) : undefined }, (chunk) => send({ type: "picli.out", runId, text: chunk })).done;
                  }),
                );
                send({ type: "picli.done", reqId, runId, op: "mcp.add", code: out.code, vars });
                if (out.code === 0) send({ type: "ext.changed", what: "mcp", id: msg.name, vars });
                return;
              }
              send({ type: "ext.op", reqId, op, state: "done", code: 0 });
            } catch (err: any) {
              fail(err);
            }
            return;
          }
          // ------------------------------------------------ /share /bug (#38)
          case "share": {
            if (!(await requireStepUp())) return;
            const sessionId = String(msg.sessionId ?? "");
            const where = sessions.locate(sessionId);
            if (!where?.file || !fs.existsSync(where.file)) {
              send({ type: "share.done", sessionId, error: "这个会话还没有写到磁盘，没有可分享的内容", errCode: "session_no_file" });
              return;
            }
            try {
              const out = await shareSession(pi.cli, where.file, where.cwd, (text) => send({ type: "share.progress", sessionId, text }));
              log(`share ${sessionId} via ${out.via}`);
              send({ type: "share.done", sessionId, ...out });
            } catch (err: any) {
              send({ type: "share.done", sessionId, error: String(err?.message ?? err) });
            }
            return;
          }
          case "bug": {
            if (!(await requireStepUp())) return;
            const sessionId = String(msg.sessionId ?? "");
            const where = sessions.locate(sessionId);
            if (!where?.file || !fs.existsSync(where.file)) {
              send({ type: "bug.done", sessionId, error: "这个会话还没有写到磁盘", errCode: "session_no_file" });
              return;
            }
            try {
              const out = await reportBug(pi.cli, where.file, where.cwd, {
                hint: typeof msg.hint === "string" ? msg.hint.slice(0, 4000) : undefined,
                includeSession: msg.includeSession === true,
                delivery: msg.delivery === "upload" ? "upload" : "zip",
              });
              log(`bug report ${out.id} (${out.delivery})`);
              send({ type: "bug.done", sessionId, id: out.id, delivery: out.delivery, ...(out.zip ? { download: `/api/bugzip?name=${encodeURIComponent(path.basename(out.zip))}` } : {}) });
            } catch (err: any) {
              send({ type: "bug.done", sessionId, error: String(err?.message ?? err) });
            }
            return;
          }
          // ------------------------------------------------ 记录（bug / 变更 / 想法 / 杂事）
          // 用户自己的随手记，和 pi 的会话无关：不 step-up、不隧道拦截（登录进来的就是本人）。
          case "notes.list": {
            send({ type: "notes", notes: listNotes() });
            return;
          }
          case "notes.save": {
            try {
              const note = saveNote({
                id: typeof msg.id === "string" ? msg.id : undefined,
                kind: msg.kind as NoteKind | undefined,
                mode: msg.mode as NoteMode | undefined,
                title: typeof msg.title === "string" ? msg.title : undefined,
                body: typeof msg.body === "string" ? msg.body : undefined,
                sessionId: typeof msg.sessionId === "string" ? msg.sessionId : null,
                sessionName: typeof msg.sessionName === "string" ? msg.sessionName : null,
                issue: typeof msg.issue === "string" ? msg.issue : undefined,
                commit: typeof msg.commit === "string" ? msg.commit : undefined,
              });
              broadcast({ type: "notes", notes: listNotes() });
              send({ type: "notes.saved", note });
            } catch (err: any) {
              send({ type: "notes.saved", error: String(err?.message ?? err) });
            }
            return;
          }
          case "notes.status": {
            try {
              const note = setNoteStatus(String(msg.id ?? ""), msg.status as NoteStatus, {
                ...(typeof msg.issue === "string" ? { issue: msg.issue } : {}),
                ...(typeof msg.commit === "string" ? { commit: msg.commit } : {}),
              });
              if (!note) send({ type: "notes.saved", error: "这条记录已经不在了" });
              else broadcast({ type: "notes", notes: listNotes() });
            } catch (err: any) {
              send({ type: "notes.saved", error: String(err?.message ?? err) });
            }
            return;
          }
          case "notes.delete": {
            const id = String(msg.id ?? "");
            if (!deleteNote(id)) send({ type: "notes.saved", error: "这条记录已经不在了" });
            else {
              log(`note deleted ${id}`);
              broadcast({ type: "notes", notes: listNotes() });
            }
            return;
          }
          case "notes.shot": {
            const id = String(msg.id ?? "");
            try {
              const out = addShot(id, String(msg.dataUrl ?? msg.data ?? ""));
              broadcast({ type: "notes", notes: listNotes() });
              send({ type: "notes.shot", id, path: out.path, shots: out.shots });
            } catch (err: any) {
              send({ type: "notes.shot", id, error: String(err?.message ?? err) });
            }
            return;
          }
          case "notes.shot.remove": {
            try {
              const shots = removeShot(String(msg.id ?? ""), String(msg.path ?? ""));
              broadcast({ type: "notes", notes: listNotes() });
              send({ type: "notes.shot", id: String(msg.id ?? ""), shots });
            } catch (err: any) {
              send({ type: "notes.shot", error: String(err?.message ?? err) });
            }
            return;
          }
          case "notes.life": {
            try {
              const note = setNoteLife(String(msg.id ?? ""), String(msg.life ?? "") as NoteLife);
              broadcast({ type: "notes", notes: listNotes() });
              send({ type: "notes.saved", note });
            } catch (err: any) {
              send({ type: "notes.saved", error: String(err?.message ?? err) });
            }
            return;
          }
          case "notes.purge": {
            try {
              const ids = typeof msg.id === "string" && msg.id ? [msg.id] : undefined;
              purgeTrash(ids);
              broadcast({ type: "notes", notes: listNotes() });
            } catch (err: any) {
              send({ type: "notes.saved", error: String(err?.message ?? err) });
            }
            return;
          }
          case "lockext.get": {
            send({ type: "lockext", ...(await lockExtStatus(pi.cli)) });
            return;
          }
          case "lockext.set": {
            // #30: install / remove the terminal session-lock extension in pi's global settings.
            if (!(await requireStepUp())) return;
            try {
              const status = msg.on ? await installLockExt(pi.cli) : await uninstallLockExt(pi.cli);
              log(`session-lock extension ${status.installed ? "installed" : "removed"}: ${status.path}`);
              send({ type: "lockext", ...status, saved: true });
            } catch (err: any) {
              send({ type: "settings.error", scope: "global", message: String(err?.message ?? err) });
            }
            return;
          }
          case "trust.get": {
            send({ type: "trust", cwd: String(msg.cwd ?? ""), trust: await trustFor(String(msg.cwd ?? "")) });
            return;
          }
          case "trust.set": {
            if (!(await requireStepUp())) return;
            const cwd = String(msg.cwd ?? "");
            const trust = await setTrust(pi.cli, cwd, Number(msg.option));
            log(`trust ${cwd} → ${trust.saved ? (trust.saved.decision ? "trusted" : "untrusted") + " @ " + trust.saved.path : "cleared"}`);
            send({ type: "trust", cwd, trust, saved: true });
            return;
          }
          // ------------------------------------------------ /login /logout (#27)
          case "auth.list": {
            send({ type: "auth.providers", providers: await listProviders(pi.cli) });
            return;
          }
          case "auth.login": {
            if (!(await requireStepUp())) return;
            const provider = String(msg.provider ?? "");
            const method = msg.method === "oauth" ? "oauth" : "api_key";
            try {
              const { loginId, done } = await startLogin(pi.cli, provider, method, { send });
              (ws as any).logins = [...((ws as any).logins ?? []), loginId];
              send({ type: "auth.started", loginId, provider, method });
              log(`login ${provider} (${method}) started`);
              void done
                .then(async () => {
                  log(`login ${provider} ok`);
                  send({ type: "auth.done", loginId, provider, ok: true });
                  send({ type: "auth.providers", providers: await listProviders(pi.cli) });
                  // New credentials can make new models available: refresh everyone's catalog.
                  broadcast({ type: "catalog", models: await sessions.models(true).catch(() => []) });
                })
                .catch((err: any) => {
                  const message = String(err?.message ?? err);
                  log(`login ${provider} failed: ${message}`);
                  send({ type: "auth.done", loginId, provider, ok: false, error: /cancel|abort/i.test(message) ? "已取消" : message });
                });
            } catch (err: any) {
              send({ type: "auth.done", loginId: null, provider, ok: false, error: String(err?.message ?? err) });
            }
            return;
          }
          case "auth.answer": {
            if (!(await requireStepUp())) return;
            answerLogin(String(msg.loginId ?? ""), String(msg.promptId ?? ""), typeof msg.value === "string" ? msg.value : null);
            return;
          }
          case "auth.cancel": {
            cancelLogin(String(msg.loginId ?? ""));
            return;
          }
          case "auth.logout": {
            if (!(await requireStepUp())) return;
            const provider = String(msg.provider ?? "");
            await logoutProvider(pi.cli, provider);
            log(`logout ${provider}`);
            send({ type: "auth.providers", providers: await listProviders(pi.cli) });
            broadcast({ type: "catalog", models: await sessions.models(true).catch(() => []) });
            return;
          }
          case "commands": {
            // #25: the `/` menu — pi's own commands for this session (extension / template / skill).
            const sessionId = String(msg.sessionId ?? "");
            const session = sessions.get(sessionId);
            const commands = session
              ? await session.commands()
              : (await sessions.skillsFor(sessionId, msg.cwd ? String(msg.cwd) : undefined)).map((sk) => ({ name: `skill:${sk.name}`, description: sk.description, source: "skill" }));
            send({ type: "commands", sessionId, commands });
            return;
          }
          case "skillUsed": {
            bumpSkillUsage(String(msg.name ?? ""));
            sessions.get(String(msg.sessionId ?? ""))?.dropSkillCache();
            return;
          }
          case "rename": {
            if (!(await requireStepUp())) return;
            await sessions.rename(String(msg.sessionId ?? ""), String(msg.name ?? ""));
            return;
          }
          case "manage": {
            // One command for the whole sidebar arrangement; delete is its own destructive action.
            if (!(await requireStepUp())) return;
            const action = String(msg.action ?? "");
            if (action === "arrange") {
              sessions.arrange(msg.pin, msg.order);
              broadcast({ type: "manage", manage: sessions.manage.snapshot() });
              return;
            }
            if (action === "archive") {
              const on = msg.on !== false;
              sessions.setArchived(Array.isArray(msg.ids) ? msg.ids.map(String) : [], on);
              broadcast({ type: "manage", manage: sessions.manage.snapshot() });
              return;
            }
            if (action === "trash" || action === "delete") {
              const report = await sessions.trash(Array.isArray(msg.ids) ? msg.ids.map(String) : []);
              if (report.removed.length) broadcast({ type: "session.gone", ids: report.removed });
              broadcast({ type: "manage", manage: sessions.manage.snapshot() });
              broadcast({ type: "trash", items: sessions.trashList() });
              // The sheet sits above the transcript, so the outcome has to come back on its own channel.
              if (report.skipped.length || report.removed.length) send({ type: "delete.result", ...report });
              return;
            }
            if (action === "trash.list") {
              send({ type: "trash", items: sessions.trashList() });
              return;
            }
            if (action === "restore") {
              const report = sessions.restore(Array.isArray(msg.ids) ? msg.ids.map(String) : []);
              if (report.restored.length) broadcast({ type: "manage", manage: sessions.manage.snapshot() });
              broadcast({ type: "trash", items: sessions.trashList() });
              if (report.restored.length) send({ type: "sessions.list", sessions: sessions.list() });
              send({ type: "restore.result", ...report });
              return;
            }
            if (action === "purge") {
              // Empty ids = empty the whole bin: that is the only action here that destroys data.
              const report = sessions.purge(Array.isArray(msg.ids) ? msg.ids.map(String) : []);
              broadcast({ type: "trash", items: sessions.trashList() });
              send({ type: "purge.result", ...report });
              return;
            }
            send({ type: "notice", text: `未知的管理操作 ${action}`, level: "warn" });
            return;
          }
          case "close": {
            if (!(await requireStepUp())) return;
            await sessions.close(msg.sessionId);
            return;
          }
          default:
            send({ type: "notice", text: `未知指令 ${msg.type}`, level: "warn" });
        }
      } catch (err: any) {
        send({ type: "notice", text: String(err?.message ?? err), level: "error" });
      }
    });
  });

  sessions.startGc((id) => [...wss.clients].some((client) => (client as any).watching === id));

  process.on("exit", () => peer.stop());

  server.listen(cfg.port, cfg.host, () => {
    log(`listening on http://${cfg.host}:${cfg.port}`);
    console.log(`\n  pi-web-client 已启动：http://127.0.0.1:${cfg.port}`);
    if (fresh) console.log(`  口令（首次生成，只显示这一次）：${fresh}\n`);
    else console.log(`  口令在 ${statePath("passphrase.txt")}\n`);
    if (cfg.tunnelAuto && tunnelBin) tunnel.start();
  });

  const shutdown = async () => {
    log("shutting down");
    terminals.closeAll();
    tunnel.stop();
    await sessions.shutdown();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
