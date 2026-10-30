import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { SessionManager, type AskAnswer, type AskQuestion } from "./sessions.ts";
import { bumpSkillUsage } from "./skills.ts";
import { Notifier } from "./notify.ts";
import { Tunnel, findCloudflared } from "./tunnel.ts";
import { resolvePi } from "./pi.ts";
import { APP_NAME, VERSION, ensureStateDirs, readJson, statePath, sessionsRoot } from "./paths.ts";

interface Config {
  port: number;
  host: string;
  tunnelAuto: boolean;
}

const STEP_UP_MS = 10 * 60 * 1000;
const MAX_BODY = 30 * 1024 * 1024;

function loadConfig(): Config {
  const cfg = readJson<Partial<Config>>(statePath("config.json"), {});
  return {
    port: Number(process.env.PI_WEB_PORT || cfg.port || 7864),
    host: process.env.PI_WEB_HOST || cfg.host || "127.0.0.1",
    tunnelAuto: process.env.PI_WEB_TUNNEL === "1" || Boolean(cfg.tunnelAuto),
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
  const target = path.join(WEB_ROOT, path.normalize(clean).replace(/^([/\\])+/, ""));
  const file = target.startsWith(WEB_ROOT) && fs.existsSync(target) && fs.statSync(target).isFile() ? target : path.join(WEB_ROOT, "index.html");
  if (!fs.existsSync(file)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("web 前端还没构建：在 web/ 下跑 npm run build");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
    "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=3600",
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

function json(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string | string[]> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
  res.end(payload);
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
  const sessions = new SessionManager(pi.cli, `http://127.0.0.1:${cfg.port}/api/ask`);
  const notifier = new Notifier();
  const tunnelBin = findCloudflared();
  const tunnel = new Tunnel(cfg.port, tunnelBin ?? "");

  const log = (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}`;
    console.log(line);
    try {
      fs.appendFileSync(statePath("logs", "bridge.log"), line + "\n");
    } catch {
      /* ignore */
    }
  };

  log(`${APP_NAME} ${VERSION} — pi ${pi.version} @ ${pi.cli}`);

  // Last line of defence: a single stray stream error used to kill the whole bridge (and with it
  // every connected client). Log it loudly and keep serving — sessions each own their child and
  // their file tail, so the rest of the server stays consistent.
  const survive = (kind: string) => (err: unknown) => {
    const e = err as any;
    log(`${kind}: ${(e?.stack ?? e?.message ?? String(err)).toString().slice(0, 4000)}`);
  };
  process.on("uncaughtException", survive("uncaughtException"));
  process.on("unhandledRejection", survive("unhandledRejection"));

  // ---------------------------------------------------------------- http
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const publicReq = isTunnelRequest(req.headers);
    const cookieHeader = req.headers.cookie;
    const ok = authorized(cookieHeader);

    if (url.pathname === "/healthz") {
      return json(res, 200, { ok: true, version: VERSION, pi: pi.version, public: publicReq });
    }

    // ------------------------------------------------------------ ask-user (loopback only)
    // The `question` / `questionnaire` extensions run inside our pi child; in rpc mode they cannot
    // open a dialog, so they post the question here and we hold the request open until the browser
    // answers. This route sits in front of the cookie gate on purpose (the child has no cookie) and
    // is hostile to the tunnel: public requests, non-loopback peers and unknown tokens all 403.
    if (url.pathname === "/api/ask" && req.method === "POST") {
      if (publicReq) return json(res, 403, { error: "forbidden" });
      const peer = req.socket.remoteAddress ?? "";
      if (!/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(peer)) return json(res, 403, { error: "forbidden" });
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
      if (!loginAllowed(ip)) return json(res, 429, { error: "试太多次了，等一分钟再试" });
      const body = await readBody(req).catch(() => ({}));
      if (!verifyPassphrase(String(body.passphrase ?? ""))) {
        log(`login failed from ${ip}`);
        return json(res, 401, { error: "口令不对" });
      }
      resetLoginAttempts(ip);
      log(`login ok from ${ip}${publicReq ? " (tunnel)" : ""}`);
      return json(res, 200, { ok: true }, { "set-cookie": [sessionCookie(issueSessionToken(), publicReq)] });
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
        pi: pi.version,
        public: publicReq,
        passphrase: currentPassphrase() ? null : "",
        tunnel: tunnel.state,
        pushKey: notifier.vapidPublicKey,
        pushCount: notifier.subscriptionCount(),
        sessionsRoot: sessionsRoot(),
      });
    }

    if (url.pathname === "/api/sessions") {
      return json(res, 200, { sessions: sessions.list(), tunnel: tunnel.state });
    }

    if (url.pathname === "/api/session" && req.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return json(res, 400, { error: "id required" });
      return json(res, 200, sessions.snapshot(id));
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
        if (!tunnelBin) return json(res, 400, { error: "没找到 cloudflared" });
        tunnel.start();
      } else if (body.action === "stop") {
        tunnel.stop();
      }
      return json(res, 200, { tunnel: tunnel.state });
    }

    if (url.pathname === "/api/notify-test" && req.method === "POST") {
      const result = await notifier.notify("pi-web-client 测试", "如果你看到这条，通知链路是通的。", `${publicReq ? tunnel.state.url ?? "" : "http://127.0.0.1:" + cfg.port}`);
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

  sessions.on("ws", broadcast);
  sessions.on("approval", (approval) => {
    const session = sessions.get(approval.sessionId);
    const name = session?.state.name ?? approval.sessionId.slice(0, 8);
    const body = approval.message.replace(/\s+/g, " ").slice(0, 140);
    const link = tunnel.state.url ? `${tunnel.state.url}/#/s/${approval.sessionId}` : `http://127.0.0.1:${cfg.port}/#/s/${approval.sessionId}`;
    void notifier.notify(`需要你批准 · ${name}`, body, link);
  });
  sessions.on("ask", (ask, tool) => {
    const session = sessions.get(ask.sessionId);
    const name = session?.state.name ?? ask.sessionId.slice(0, 8);
    const first = ask.questions[0];
    const body = (first?.prompt ?? "").replace(/\s+/g, " ").slice(0, 140);
    const more = ask.questions.length > 1 ? `（${ask.questions.length} 题）` : "";
    const link = tunnel.state.url ? `${tunnel.state.url}/#/s/${ask.sessionId}` : `http://127.0.0.1:${cfg.port}/#/s/${ask.sessionId}`;
    void notifier.notify(`需要你回答${more} · ${name}`, body, link);
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
      pi: pi.version,
      sessions: sessions.list(),
      manage: sessions.manage.snapshot(),
      tunnel: tunnel.state,
      public: (ws as any).publicReq,
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

    ws.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        switch (msg.type) {
          case "stepup": {
            if (!verifyPassphrase(String(msg.passphrase ?? ""))) {
              send({ type: "notice", text: "口令不对", level: "error" });
              return;
            }
            (ws as any).stepUntil = Date.now() + STEP_UP_MS;
            send({ type: "stepup-ok", until: (ws as any).stepUntil });
            return;
          }
          case "models": {
            send({ type: "catalog", models: await sessions.models(true).catch(() => []) });
            return;
          }
          case "subscribe": {
            const snap = sessions.snapshot(msg.sessionId);
            send({ type: "session", sessionId: msg.sessionId, ...snap });
            return;
          }
          case "claim": {
            if (!(await requireStepUp())) return;
            const session = await sessions.claim(String(msg.sessionId));
            send({ type: "session", sessionId: session.state.id, ...session.snapshot() });
            return;
          }
          case "prompt": {
            if (!(await requireStepUp())) return;
            const session = await sessions.openLive(msg.sessionId);
            await session.prompt(String(msg.text ?? ""), msg.images);
            return;
          }
          case "create": {
            if (!(await requireStepUp())) return;
            const session = await sessions.create(String(msg.cwd || process.cwd()), msg.name);
            send({ type: "session", sessionId: session.state.id, ...session.snapshot() });
            broadcast({ type: "session.state", session: session.state });
            return;
          }
          case "abort": {
            if (!(await requireStepUp())) return;
            sessions.get(msg.sessionId)?.abort();
            return;
          }
          case "compact": {
            if (!(await requireStepUp())) return;
            await sessions.get(msg.sessionId)?.compact();
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
            await sessions.get(msg.sessionId)?.setModel(msg.provider, msg.modelId);
            return;
          }
          case "setThinking": {
            if (!(await requireStepUp())) return;
            await sessions.get(msg.sessionId)?.setThinking(String(msg.level));
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
            if (action === "delete") {
              const removed = await sessions.remove(Array.isArray(msg.ids) ? msg.ids.map(String) : []);
              broadcast({ type: "session.gone", ids: removed });
              broadcast({ type: "manage", manage: sessions.manage.snapshot() });
              return;
            }
            send({ type: "notice", text: `未知的管理操作 ${action}`, level: "warn" });
            return;
          }
          case "close": {
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

  sessions.startGc();

  server.listen(cfg.port, cfg.host, () => {
    log(`listening on http://${cfg.host}:${cfg.port}`);
    console.log(`\n  pi-web-client 已启动：http://127.0.0.1:${cfg.port}`);
    if (fresh) console.log(`  口令（首次生成，只显示这一次）：${fresh}\n`);
    else console.log(`  口令在 ${statePath("passphrase.txt")}\n`);
    if (cfg.tunnelAuto && tunnelBin) tunnel.start();
  });

  const shutdown = async () => {
    log("shutting down");
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
