import { randomUUID } from "node:crypto";
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
  generatePassphrase,
  isTunnelRequest,
  issueSessionToken,
  loginAllowed,
  setPassphrase,
  resetLoginAttempts,
  sessionCookie,
  verifyPassphrase,
} from "./auth.ts";
import { stateDir } from "./paths.ts";
import { pageBefore } from "./history.ts";
import type { StateFailure } from "./statefile.ts";
import { writeLifecycle } from "./lifecycle.ts";
import { Terminals, openConsole, openWithApp, revealInFileManager } from "./terminal.ts";
import { SessionManager, isPermissionMode, type AskAnswer, type AskQuestion, type RuntimeStats } from "./sessions.ts";
import { resolveChildSessionFile } from "./bgruns.ts";
import { entriesToItems } from "./items.ts";
import type { Item } from "./items.ts";
import { loadEntries, type SessionEntry } from "./sessionfile.ts";
import { planReplayFromEntries, type PlanSnapshot } from "./execplan.ts";
import { defaultPermission } from "./permissiondefault.ts";
import { bumpSkillUsage } from "./skills.ts";
import { describeStoreSkills, installSkill, installedSkills, previewSource, removeSkill, searchSkillStore } from "./skillstore.ts";
import { Notifier } from "./notify.ts";
import { anyPresent, dropClient, reportPresence } from "./presence.ts";
import { Tunnel, findCloudflared, type TunnelState } from "./tunnel.ts";
import { resolvePi, readVersion } from "./pi.ts";
import { APP_NAME, VERSION, agentDir, ensureStateDirs, readJson, resetScratchDir, statePath, sessionsRootInfo } from "./paths.ts";
import { BUILD_ID } from "./build-id.ts";
import { removePidFile, writePidFile } from "./pidfile.ts";
import { clipboardFiles, listDirs, makeDir, makeFile, statFiles, statPath } from "./dirs.ts";
import { gitFetch, gitHistory, GitHistoryError, gitInfo, probeChildren } from "./git.ts";
import { executeGitOp, gitDiff, gitRefs, gitState, type GitOpParams } from "./gitops.ts";
import { listFiles, rankFiles } from "./filesearch.ts";
import { changelog, installLockExt, lockExtStatus, readSettings, setTrust, trustInfo, uninstallLockExt, writeSettings } from "./pisettings.ts";
import { selfChangelog } from "./whatsnew.ts";
import { scanSubagents } from "./subagents.ts";
import { acpConfigPath, readAcpDelegate, writeAcpDelegate, writeThinkingFix } from "./acpdelegate.ts";
import { cleanLaunch } from "./launch.ts";
import { depsReport } from "./depsstatus.ts";
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
import { actOnFailure, emptyLedger, mergeFailures, readLedger, undoFailures, type CommitItem, type FailAction } from "./failures.ts";
import { allowRemind, reminderText, reviewPrompt } from "./lessons.ts";
import { deleteRule, markReviewed, readRules, setRule } from "./rules.ts";
import { mcpAddRequest, newer, searchMcp, searchPackages, setIndexListener, type McpInstallOption } from "./market.ts";
import { bumpMcp, inventory, readUiPrefs, toggleExtension, toggleMcp, updateCount, writeUiPrefs } from "./extmgr.ts";
import { marketDelete, marketInstall, marketList, marketPublish, marketSources, marketUninstall, type PublishInput } from "./market-lan.ts";
import { createWriteLock } from "./writelock.ts";
import { answer as answerLogin, cancel as cancelLogin, listProviders, login as startLogin, logout as logoutProvider } from "./pilogin.ts";
import { handleJira, readAttachmentRoot } from "./jira.ts";
import { handleSysmanage } from "./sysmanage.ts";
import { piLatest } from "./piupdate.ts";
import { isTrustedPreviewPath, kindOf, openPreview, readAttachableImage, readTextFile, rememberEditable, resolvePreviewPath, savePreviewFile, serveRaw, writeTextFile } from "./preview.ts";
import { MAX_TRANSLATE_BYTES, TR_DEFAULT_MODEL, TR_LANGS, applySync, cutSections, isTrLang, planSync, readDoc, readTrPrefs, runPiTranslate, splitSections, writeDoc, writeTrPrefs, type TrLang, type TrSection } from "./translate.ts";
import { TranslateJobs } from "./translatejob.ts";
import { diffArtifact, listArtifacts, recordSnapshot } from "./artifacts.ts";
import { fileGrant, findSheet, grantIsStale, readMeta as readSheetMeta, readWindow as readSheetWindow } from "./sheet/index.ts";
import { sheetPdfFile, sheetPdfKey, sheetPdfStatus } from "./sheet/pdf.ts";
import { countSlides, slidesAvailable, slidesPdfFile, slidesPdfKey, slidesPdfStatus, slidesProbe } from "./slides/index.ts";
import { PeerHost, peerEntry } from "./peer.ts";

interface Config {
  port: number;
  host: string;
  tunnelAuto: boolean;
  /** 局域网 peer 的 HTTP 端口（#45）；`PI_PEER=0` 关掉整块功能。 */
  peerPort: number;
}

/** D186：公网写入窗口 1 天（原 D15 是 10 分钟）—— 手机上批准不该一轮对话就重输一次口令。 */
const STEP_UP_MS = 24 * 60 * 60 * 1000;
const MAX_BODY = 30 * 1024 * 1024;

interface ChildWatch {
  sessionId: string;
  runId: string;
  timer: NodeJS.Timeout;
  file: string | null;
  size: number;
  mtime: number;
  items: Item[];
  plan: PlanSnapshot | null;
  stats: ChildSessionStats | null;
  state: string;
}

interface ChildSessionStats {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } | null;
  cost: number | null;
  contextTokens: null;
  contextWindow: null;
}

/** Child session files have no live RPC stats endpoint, so derive cumulative usage from saved assistant entries. */
function childSessionStats(entries: SessionEntry[]): ChildSessionStats {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let sawTokens = false;
  let cost = 0;
  let sawCost = false;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const usage = entry.message.usage;
    if (!usage || typeof usage !== "object") continue;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const value = usage[key];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      tokens[key] += value;
      sawTokens = true;
    }
    const total = typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)
      ? usage.totalTokens
      : tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) sawTokens = true;
    tokens.total += total;
    const messageCost = usage.cost?.total;
    if (typeof messageCost === "number" && Number.isFinite(messageCost)) {
      cost += messageCost;
      sawCost = true;
    }
  }
  return {
    tokens: sawTokens ? tokens : null,
    cost: sawCost ? cost : null,
    contextTokens: null,
    contextWindow: null,
  };
}

/**
 * 关隧道时给回包留的时间：先把响应写出去，再等这么久才杀 cloudflared。
 * 前半段是 `res.end` 的回调（数据已交给内核），剩下的留给 cloudflared 把回包转给 Cloudflare 边缘。
 */
const TUNNEL_STOP_GRACE_MS = 400;

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

/** 回环对端（`::1` / IPv4-mapped / `127.0.0.1`）。/api/ask、/api/preview/open 与 /api/peer 共用一份，
 *  将来放宽一处（比如局域网）不会再漏掉另一处。 */
function isLoopbackPeer(addr: string): boolean {
  return /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(addr);
}

/**
 * `preview.open` 的回执表（#224 复审）：桥把帧投出去之后要等页面说「接住了」才算打开。
 * 键是 reqId —— 一次请求可能投给多个页签，每份一个 reqId；页面在**自己那条 ws** 上回
 * `{type:"preview.open.done", reqId, ok, reason?, text?}`。
 */
/**
 * D245 「同步回原文」的待写内容：/sync 算好放在这里，/apply 只认这个 id 写盘。
 * 页面拿不到全文，也就没法把别的内容塞进写路径；10 分钟没用就丢（文件可能早被改了）。
 */
const pendingApply = new Map<
  string,
  { abs: string; lang: TrLang; mtime: number; size: number; text: string; enc: "utf8" | "gbk"; bom: boolean; at: number }
>();

function dropStaleApplies(): void {
  for (const [k, v] of pendingApply) if (Date.now() - v.at > 10 * 60_000) pendingApply.delete(k);
}

const pendingPreview = new Map<string, { ws: WebSocket; settle: (ack: PreviewAck) => void }>();

interface PreviewAck {
  ok: boolean;
  reason?: string;
  text?: string;
}

/** 页面回执的等待上限：15 秒够一个慢标签页把弹窗画出来，也不至于让模型干等太久。 */
const PREVIEW_ACK_MS = (() => {
  const n = Number(process.env.PI_WEB_PREVIEW_ACK_MS ?? 15000);
  return Number.isFinite(n) && n > 0 ? n : 15000;
})();

/** 投一帧给一个页签，等它的回执；超时或那条 ws 关掉都算 `no-ack`（结算一次，别泄漏）。 */
function askPreviewAck(client: WebSocket, paint: (reqId: string) => void): Promise<PreviewAck> {
  return new Promise((resolve) => {
    if (client.readyState !== WebSocket.OPEN) {
      resolve({ ok: false, reason: "no-ack" });
      return;
    }
    const reqId = randomUUID();
    const settle = (ack: PreviewAck) => {
      const entry = pendingPreview.get(reqId);
      if (!entry) return;
      pendingPreview.delete(reqId);
      clearTimeout(timer);
      resolve(ack);
    };
    const timer = setTimeout(() => settle({ ok: false, reason: "no-ack" }), PREVIEW_ACK_MS);
    pendingPreview.set(reqId, { ws: client, settle });
    paint(reqId);
  });
}

/** 第一个「有结论」的回执说了算：`stale`（这张页签没在看）要跳过，否则它会盖掉真正接住的那页。 */
async function firstPreviewAck(acks: Promise<PreviewAck>[]): Promise<PreviewAck> {
  if (!acks.length) return { ok: false, reason: "no-ack" };
  let stale = 0;
  return new Promise((resolve) => {
    for (const ack of acks) {
      void ack.then((a) => {
        if (a.reason === "stale") {
          // 全都说「我没在看」= 没有任何页签接住，按没回执算。
          if (++stale === acks.length) resolve({ ok: false, reason: "no-ack" });
          return;
        }
        resolve(a);
      });
    }
  });
}

/**
 * 表格端点共同前置（D166/#106）：拿凭据 → stat → 判 mtime 未变。任一失败已经写好响应并返回 null；
 * 调用方 `if (!g) return;`。返回的 mtimeMs 是 stat 后的实际值（pdf 缓存键要用）。
 */
async function resolveSheetGrant(res: http.ServerResponse, token: string): Promise<{ abs: string; mtimeMs: number } | null> {
  const grant = fileGrant(token);
  if (!grant) {
    fail(res, 403, "sheet_grant", "预览凭据无效或已过期，请重新打开文件");
    return null;
  }
  try {
    const st = await fs.promises.stat(grant.abs);
    if (grantIsStale(grant, st.mtimeMs)) {
      fail(res, 400, "sheet_stale", "文件已改变，请重新打开");
      return null;
    }
    return { abs: grant.abs, mtimeMs: st.mtimeMs };
  } catch {
    fail(res, 404, "sheet_gone", "文件已不在原处");
    return null;
  }
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
  // 随手问 (#86): nothing can be live at this point (it is created lazily), so wiping its dir is
  // unconditional — that is what makes 「桥重启 = 清空」 true, crashes included.
  resetScratchDir();
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
  const sessions = new SessionManager(pi.cli, `http://127.0.0.1:${cfg.port}`);
  const translateJobs = new TranslateJobs();
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
  // D220 的判据是 `pi list`（用户级包），不是磁盘上的文件名 —— ask 从 D90 起是 npm 包
  // `@juicesharp/rpiv-ask-user-question`，`~/.pi/agent/extensions/question.ts` 那里永远没有它。
  void depsReport(pi.cli, piVersion)
    .then((report) => {
      const ask = report.packages.find((p) => p.id === "questionnaire");
      const state = ask?.installed ? `在${ask.foundVersion ? ` ${ask.foundVersion}` : ""}${ask.behind ? `（清单钉的是 ${ask.version}，该升级）` : ""}` : "缺";
      log(`ask 扩展：${ask?.name ?? "@juicesharp/rpiv-ask-user-question"}=${state}（缺了就只能由模型把表单写成文字）`);
    })
    .catch(() => {
      /* 只是诊断信息 */
    });

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
    const session = body?.token ? sessions.byLoopbackToken(String(body.token)) : null;
    log(`ask rejected (${why})${session ? ` for ${session.state.id.slice(0, 8)}` : ""}`);
    if (session) session.notice(text, "warn");
    else broadcast({ type: "notice", text, level: "warn" });
    return json(res, 403, { error: why, text });
  };

  /**
   * D209：用户自己配的「文件就在这儿」的两处根 —— Jira 附件根（D205）与内网通收件箱（#45）。
   * 每请求现读一次：改了设置，旧目录立刻不再是可信根（不缓存路径）。
   */
  const previewPins = (): string[] => {
    const jira = readAttachmentRoot();
    const inbox = peer.view().status?.config?.inbox ?? null;
    return [jira, inbox].filter((root): root is string => Boolean(root));
  };

  // ---------------------------------------------------------------- http
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const publicReq = isTunnelRequest(req.headers);
    const cookieHeader = req.headers.cookie;
    const ok = authorized(cookieHeader);

    if (url.pathname === "/healthz") {
      // pid 只回给本机：更新器靠它确认「谁在服务这个端口」（沙箱/代理下 netstat 看不到监听者）。
      // 隧道访客不需要知道，也不该拿到 —— 注意 cloudflared 是本地起的（`--url 127.0.0.1`），
      // 隧道流量的 remoteAddress 天然就是 loopback，只比地址会把 pid 漏给公网，必须连 publicReq 一起看。
      const remote = req.socket.remoteAddress;
      const loopback =
        (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") && !publicReq;
      return json(res, 200, {
        ok: true,
        version: VERSION,
        buildId: BUILD_ID,
        pi: piVersion,
        public: publicReq,
        ...(loopback ? { pid: process.pid } : {}),
      });
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
      if (!isLoopbackPeer(peer)) return askRefused(req, res, "提问只接受本机回环的请求（扩展与网页必须在这台电脑上）。", "non-loopback");
      let body: any;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: "bad json" });
      }
      // The token is the identity: it resolves to exactly one session, so nothing in the body can
      // claim to be another one.
      const session = sessions.byLoopbackToken(String(body.token ?? ""));
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

    // ------------------------------------------------------------ open_preview (loopback only, #224)
    // `open_preview` 工具跑在我们的子进程里，没有 cookie，所以和 /api/ask 一样站在 cookie 闸前面，
    // 只认回环对端 + 会话级 token。它的活只有一件：把「打开这个文件」交给正在看这个会话的页面。
    // 没有这样的连接就明确失败 —— 工具不能把「没人看见」当成「打开了」（投递范围的收紧见 #225）。
    if (url.pathname === "/api/preview/open" && req.method === "POST") {
      if (publicReq) return json(res, 403, { ok: false, reason: "tunnel", text: "预览只接受本机回环的请求（公网隧道进不来）。" });
      const peer = req.socket.remoteAddress ?? "";
      if (!isLoopbackPeer(peer)) return json(res, 403, { ok: false, reason: "non-loopback", text: "预览只接受本机回环的请求。" });
      const body = await readBody(req).catch(() => ({}));
      const session = sessions.byLoopbackToken(String(body.token ?? ""));
      if (!session) {
        log(`preview.open rejected: bad token from ${peer}`);
        return json(res, 403, { ok: false, reason: "bad-token", text: "回环凭据不对。" });
      }
      const sess = { cwd: session.state.cwd, file: session.state.file };
      const rawPath = String(body.path ?? "");
      let abs: string;
      try {
        abs = resolvePreviewPath(sess, rawPath);
      } catch (err: any) {
        return json(res, 200, { ok: false, reason: "path", text: String(err?.message ?? err) });
      }
      // #225: 这个工具能把任意绝对路径推进预览面板，而页面上能点开的只限于会话目录（D50 的宽松规则
      // 只属于 /api/preview 与 /api/dirs）。目录外的路径，只有会话记录里真出现过才放行；拒绝时不签发凭据。
      if (!isTrustedPreviewPath(sess, abs, previewPins())) {
        log(`preview.open rejected: untrusted path for ${session.state.id.slice(0, 8)}: ${abs}`);
        return json(res, 200, {
          ok: false,
          reason: "untrusted-path",
          text: "这个路径不在会话目录里，会话记录里也没提到过，所以没有打开。把文件放到会话目录里再试，或者直接把路径写出来。",
        });
      }
      let info: ReturnType<typeof openPreview>;
      try {
        info = openPreview(sess, rawPath, previewPins());
      } catch (err: any) {
        return json(res, 200, { ok: false, reason: "path", text: String(err?.message ?? err) });
      }
      const sid = session.state.id;
      const pages: WebSocket[] = [];
      for (const client of wss.clients) {
        if ((client as any).watching === sid && client.readyState === WebSocket.OPEN) pages.push(client);
      }
      log(`preview.open ${sid.slice(0, 8)} → ${pages.length} page(s): ${info.abs}`);
      if (!pages.length) return json(res, 200, { ok: false, reason: "no-page", text: "没有页面在看这个会话，预览没打开。" });
      // #224 复审：发送不等于打开。页面可能刚关了会话、正在处理别的操作，或者编辑器里还有没保存的改动
      // —— 它自己会回一条 `preview.open.done`；只有真接住（ok:true）才回给模型 ok:true。
      const ack = await firstPreviewAck(
        pages.map((client) =>
          askPreviewAck(client, (reqId) =>
            client.send(JSON.stringify({ type: "preview.open", sessionId: sid, path: info.abs, reqId })),
          ),
        ),
      );
      if (ack.ok) return json(res, 200, { ok: true, path: info.abs, name: info.name });
      if (ack.reason === "declined") {
        return json(res, 200, { ok: false, reason: "declined", text: ack.text ?? "用户选择留在编辑器里，没有打开这个文件。" });
      }
      log(`preview.open ${sid.slice(0, 8)} → no ack (${ack.reason ?? "?"})`);
      return json(res, 200, { ok: false, reason: "no-ack", text: "页面没有回应这次打开（可能刚关掉会话或在处理别的操作）。" });
    }

    // ------------------------------------------------------------ 产物基线 (loopback only, D208)
    // `artifact-snapshot` 扩展在 `tool_call` 里等这个请求，回去以后 pi 才真正写文件 —— 所以这里读到的
    // 一定是写入前的字节。和 /api/ask、/api/preview/open 一样：只认回环 + 会话级 token，没有 cookie。
    // 失败一律 200：记账失败不能让一次写入失败，扩展那边也不解析错误体。
    if (url.pathname === "/api/artifacts/snapshot" && req.method === "POST") {
      if (publicReq) return json(res, 403, { ok: false, reason: "tunnel" });
      const peer = req.socket.remoteAddress ?? "";
      if (!isLoopbackPeer(peer)) return json(res, 403, { ok: false, reason: "non-loopback" });
      const body = await readBody(req).catch(() => ({}));
      const session = sessions.byLoopbackToken(String(body.token ?? ""));
      if (!session) {
        log(`artifacts.snapshot rejected: bad token from ${peer}`);
        return json(res, 403, { ok: false, reason: "bad-token" });
      }
      try {
        const abs = resolvePreviewPath({ cwd: session.state.cwd }, String(body.path ?? ""));
        const out = recordSnapshot(session.state.id, abs);
        return json(res, 200, { ok: true, kept: out.kept, existed: out.snap?.existed ?? null });
      } catch (err: any) {
        log(`artifacts.snapshot failed: ${String(err?.message ?? err)}`);
        return json(res, 200, { ok: false, error: String(err?.message ?? err) });
      }
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
    const loopbackPeer = isLoopbackPeer(req.socket.remoteAddress ?? "");
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
      const actions = ["request", "quick", "accept", "favorite", "remove"] as const;
      type FriendAction = (typeof actions)[number];
      if (!(actions as readonly string[]).includes(action)) return json(res, 400, { error: "未知动作" });
      try {
        return json(res, 200, await peer.friend(String(body?.peer ?? ""), action as FriendAction, Boolean(body?.on)));
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
    // 手工上传 zip：和 /api/peer/upload 一样走原始字节，不把 64 MB 塞进 base64 的 WS 帧。
    if (url.pathname === "/api/market/publish-zip" && req.method === "POST") {
      const raw = await readRaw(req, 64 * 1024 * 1024).catch(() => null);
      if (!raw) return json(res, 413, { error: "太大了（上限 64 MB）" });
      if (!authorized(req.headers.cookie)) return json(res, 401, { error: "要登录" });
      if (isTunnelRequest(req.headers)) return json(res, 403, { error: "通过公网访问时局域网市场只能查看" });
      try {
        const out = await marketPublish(peer, {
          item: { type: "skill", delivery: "archive", category: "其他", description: "", name: "", version: 0 },
          source: { kind: "zip", zipB64: raw.toString("base64") },
          scope: "global", cwd: null,
        } as PublishInput);
        return json(res, out.ok ? 200 : 400, out);
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
      // 浏览器取消下载 / 关掉预览时把上游也断开；否则 30 秒的「等头」计时器已经不生效，
      // 这条 stream 会一直挂在 peer 上。
      const ctrl = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) ctrl.abort();
      });
      try {
        const upstream = await peer.fileStream(url.searchParams.get("id") ?? "", ctrl.signal);
        if (!upstream.ok || !upstream.body) return json(res, upstream.status, { error: "取不到这个文件" });
        const headers: Record<string, string> = { "cache-control": "private, max-age=60" };
        for (const key of ["content-type", "content-length", "content-disposition"]) {
          const value = upstream.headers.get(key);
          if (value) headers[key] = value;
        }
        res.writeHead(200, headers);
        const body = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
        // 流断了（客户端断开 / peer 出错）要自己收尾：pipe 不转发 error，冒出去就是 uncaughtException。
        body.on("error", (err) => {
          log(`peer 文件流中断：${(err as Error).message}`);
          if (!res.writableEnded) res.destroy();
        });
        body.pipe(res);
        return;
      } catch (err) {
        // 客户端先断了（ctrl 已 abort），这条错误没人收；再写就是往 destroyed socket 上写。
        if (res.destroyed || res.writableEnded) return;
        return json(res, 404, { error: (err as Error).message });
      }
    }
    // D209：内网通收到的文件，点卡片就用本机程序打开（收件目录里的那份真文件，不是下载副本）。
    if (url.pathname === "/api/peer/open" && req.method === "POST") {
      if (publicReq) return fail(res, 403, "open_public", "公网不能打开本机程序");
      const body = await readBody(req).catch(() => ({}));
      const abs = await peer.filePath(String(body?.id ?? ""));
      if (!abs) return fail(res, 404, "peer_file", "取不到这个文件（可能已经被挪走了）");
      return json(res, 200, await openWithApp(abs));
    }
    if (url.pathname === "/api/peer/add" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      try {
        return json(res, 200, await peer.addManual(String(body?.addr ?? "")));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (url.pathname === "/api/peer/ignored" && req.method === "GET") {
      try {
        return json(res, 200, await peer.ignored());
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (url.pathname === "/api/peer/ignored/clear" && req.method === "POST") {
      try {
        return json(res, 200, await peer.clearIgnored());
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (url.pathname === "/api/peer/config" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      const patch: { hidden?: boolean; dnd?: boolean; pauseFiles?: boolean } = {};
      for (const key of ["hidden", "dnd", "pauseFiles"] as const) {
        if (typeof body?.[key] === "boolean") patch[key] = body[key];
      }
      try {
        return json(res, 200, await peer.setConfig(patch));
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

    // #266 本机管理：读本机信息；DNS 改动只有本机/局域网能发起，公网在模块里 403。
    if (await handleSysmanage(req, res, url, { publicReq, port: cfg.port, version: VERSION, log })) return;

    // #248 Jira 面板：单站点、只读、凭据不出桥。路由都在 jira.ts 里，这里只接线。
    if (await handleJira(req, res, url, { publicReq })) return;

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

    // 文件管理器的「输入路径」：先问这条路径是文件夹、文件还是没有，再决定是进去还是高亮那一行。
    if (url.pathname === "/api/stat" && req.method === "GET") {
      return json(res, 200, await statPath(url.searchParams.get("path") ?? ""));
    }

    // Q-021: the branch under the composer. D240: 登录口令是唯一边界，公网 / 局域网访客
    // 和本机一样能读分支名（不再按 publicReq / 回环地址分流）。
    if (url.pathname === "/api/git" && req.method === "GET") {
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

    // 分支历史弹窗（D193）：两列提交 + ahead/behind，只读。D240: 公网 / 局域网同样可读。
    if (url.pathname === "/api/git/history" && req.method === "GET") {
      const dir = (url.searchParams.get("dir") ?? "").trim();
      if (!dir) return fail(res, 400, "dir_empty", "dir 不能为空", undefined, { repo: null });
      if (!path.isAbsolute(dir)) return fail(res, 400, "dir_not_absolute", "dir 必须是绝对路径", undefined, { repo: null });
      const n = Number(url.searchParams.get("n") ?? "") || 80;
      try {
        const history = await gitHistory(dir, { base: url.searchParams.get("base") ?? "", n, fresh: url.searchParams.get("fresh") === "1" });
        return json(res, 200, history ?? { repo: null });
      } catch (err: any) {
        const code = err instanceof GitHistoryError ? err.code : "history_failed";
        return json(res, 200, { repo: null, code, error: String(err?.message ?? err).slice(0, 200) });
      }
    }

    // 弹窗里那个「⧗ Fetch origin」。D240: 公网 / 局域网同样能发起；gitFetch 自己仍带
    // 45 秒超时与 GIT_TERMINAL_PROMPT=0 / GIT_ASKPASS=echo / credential.interactive=never 三件套。
    if (url.pathname === "/api/git/fetch" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      const dir = String(body?.dir ?? "").trim();
      if (!dir) return fail(res, 400, "dir_empty", "dir 不能为空");
      if (!path.isAbsolute(dir)) return fail(res, 400, "dir_not_absolute", "dir 必须是绝对路径");
      try {
        return json(res, 200, { ok: true, ...(await gitFetch(dir)) });
      } catch (err: any) {
        // gitFetch 的失败走 Object.assign(…, {code:"fetch_failed"})，和 GitHistoryError 是两种错，统一取 code 再兜一层。
        const code = err instanceof GitHistoryError ? err.code : (err?.code ?? "fetch_failed");
        return json(res, 200, { ok: false, code, error: String(err?.message ?? err).slice(0, 300) });
      }
    }

    // D235: 分支操作工作台。D240: 不再按 publicReq / 回环地址分流 —— cookie 闸（上面 `ok`）
    // 是唯一边界，登录后的公网隧道与局域网访客和本机同样能读状态、执行白名单动词。
    if (url.pathname.startsWith("/api/git/") && ["/api/git/state", "/api/git/refs", "/api/git/diff", "/api/git/op", "/api/git/probe"].includes(url.pathname) && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      const dir = String(body?.dir ?? "").trim();
      if (!dir) return fail(res, 400, "dir_empty", "dir 不能为空");
      if (!path.isAbsolute(dir)) return fail(res, 400, "dir_not_absolute", "dir 必须是绝对路径");
      try {
        // #392 目录与仓库：展开一层时批量问「哪些直接子目录自己是仓库」。只读，公网 / 局域网同样可问。
        if (url.pathname === "/api/git/probe") {
          return json(res, 200, await probeChildren(dir, body?.names, { fresh: body?.fresh === true }));
        }
        if (url.pathname === "/api/git/state") return json(res, 200, await gitState(dir));
        if (url.pathname === "/api/git/refs") return json(res, 200, await gitRefs(dir));
        if (url.pathname === "/api/git/diff") {
          return json(res, 200, await gitDiff(
            dir,
            String(body?.base ?? ""),
            String(body?.target ?? "HEAD"),
            String(body?.commit ?? ""),
          ));
        }
        const id = String(body?.id ?? "").trim();
        const params = (body?.params && typeof body.params === "object" && !Array.isArray(body.params) ? body.params : {}) as GitOpParams;
        if (!id) return fail(res, 400, "op_id_empty", "操作 id 不能为空");
        return json(res, 200, await executeGitOp(dir, id, params));
      } catch (err: any) {
        const code = err?.code ?? "op_failed";
        return json(res, 200, { ok: false, code, error: String(err?.message ?? err).slice(0, 300) });
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
        const info = openPreview(where, String(body.path ?? ""), previewPins());
        // 公网不读表内容（US 46）：xlsx 与 csv/tsv 的字节都不给；.xls/.ods 走二进制分支本就只给「用默认程序打开」，open 已另拒。
        const ext = path.extname(info.abs).toLowerCase();
        if (publicReq && (info.kind === "sheet" || ext === ".csv" || ext === ".tsv")) {
          return fail(res, 403, "sheet_public", "通过公网访问时不提供表格内容，回本机操作");
        }
        // D209：演示文稿内容也不从公网给（与表格同一条隐私口径，演示稿比表格更不该外泄）。
        if (publicReq && info.kind === "slides") {
          return fail(res, 403, "slides_public", "通过公网访问时不提供演示文稿内容，回本机操作");
        }
        // 页数与本机能不能转：提前告诉页面，别让它点开就开始轮询一个注定失败的转换。
        if (info.kind === "slides") info.slides = { pages: await countSlides(info.abs), engine: slidesAvailable() };
        // 公网也不泄本机绝对路径（US 46 延伸）：binary 分支（.xls/.ods/加密包）内容与 open 都已拒，路径一并抹掉。
        // PDF 现在有自己的 kind（浏览器内嵌看），路径同样不给。
        if (publicReq && (info.kind === "binary" || info.kind === "pdf")) info.abs = "";
        // Text files opened here become writable for this session (D50).
        rememberEditable(sessionId, info);
        return json(res, 200, info);
      } catch (err: any) {
        return json(res, 400, { error: String(err?.message ?? err) });
      }
    }

    // D208: 产物弹窗的数据。页面把自己重放历史时收到的 write/edit 路径递过来（最近写的在前），
    // 桥负责解析、查基线、算行数；路径来自已登录页面，读盘本身不超过 /api/preview 已有的能力。
    if (url.pathname === "/api/artifacts/list" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      const sessionId = String(body.sessionId ?? "");
      const where = sessions.locate(sessionId);
      if (!where) return fail(res, 404, "session_not_found", "找不到这个会话");
      const raw = Array.isArray(body.items) ? body.items : [];
      const items = raw
        .filter((it: any) => it && typeof it.path === "string")
        .slice(0, 500)
        .map((it: any) => ({ path: String(it.path), tool: String(it.tool ?? "write"), writes: Number(it.writes) || 1 }));
      try {
        return json(res, 200, await listArtifacts(sessionId, where.cwd, items));
      } catch (err: any) {
        log(`artifacts.list failed: ${String(err?.message ?? err)}`);
        return fail(res, 500, "artifacts_failed", "读不了这个会话的产物");
      }
    }

    if (url.pathname === "/api/artifacts/diff" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      const sessionId = String(body.sessionId ?? "");
      const where = sessions.locate(sessionId);
      if (!where) return fail(res, 404, "session_not_found", "找不到这个会话");
      try {
        // 没基线不是错误，是答案的一种（D208）：200 + reason，页面用 diffReasonText 说人话。
        return json(res, 200, await diffArtifact(sessionId, where.cwd, String(body.path ?? "")));
      } catch (err: any) {
        return fail(res, 400, "artifacts_diff", String(err?.message ?? err));
      }
    }

    // D166: spreadsheet reads. The page only ever sends the grant token from /api/preview; the
    // bridge resolves the path itself, refuses a file whose mtime moved, and returns one row window.
    if (url.pathname === "/api/sheet/meta" && req.method === "POST") {
      if (publicReq) return fail(res, 403, "sheet_public", "通过公网访问时不提供表格内容，回本机操作");
      const body = await readBody(req).catch(() => ({}));
      const grant = await resolveSheetGrant(res, String(body.token ?? ""));
      if (!grant) return;
      try {
        return json(res, 200, await readSheetMeta(grant.abs));
      } catch (err: any) {
        return fail(res, 400, String(err?.code ?? ""), String(err?.message ?? err));
      }
    }

    if (url.pathname === "/api/sheet/window" && req.method === "POST") {
      if (publicReq) return fail(res, 403, "sheet_public", "通过公网访问时不提供表格内容，回本机操作");
      const body = await readBody(req).catch(() => ({}));
      const num = (v: unknown): number | null => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
      const r0 = num(body.r0);
      const r1 = num(body.r1);
      const c0 = num(body.c0);
      const c1 = num(body.c1);
      if (r0 === null || r1 === null || c0 === null || c1 === null) {
        return fail(res, 400, "sheet_range", "缺少行区间");
      }
      const grant = await resolveSheetGrant(res, String(body.token ?? ""));
      if (!grant) return;
      try {
        return json(res, 200, await readSheetWindow(grant.abs, String(body.sheet ?? ""), r0, r1, c0, c1));
      } catch (err: any) {
        return fail(res, 400, String(err?.code ?? ""), String(err?.message ?? err));
      }
    }

    // #107：查找走服务端。前端只拿着一个可视窗口，整表搜不了；这里也只回坐标。
    if (url.pathname === "/api/sheet/find" && req.method === "POST") {
      if (publicReq) return fail(res, 403, "sheet_public", "通过公网访问时不提供表格内容，回本机操作");
      const body = await readBody(req).catch(() => ({}));
      const grant = await resolveSheetGrant(res, String(body.token ?? ""));
      if (!grant) return;
      try {
        return json(res, 200, await findSheet(grant.abs, String(body.sheet ?? ""), String(body.q ?? "")));
      } catch (err: any) {
        return fail(res, 400, String(err?.code ?? ""), String(err?.message ?? err));
      }
    }


    // #112: the page view is a PDF LibreOffice lays out once per path+mtime. Two-stage contract
    // (spec): POST returns a `ready` | `pending` id and kicks conversion off in the background; GET
    // streams the finished bytes. Deliberately NOT /raw — that route stamps `content-security-policy:
    // sandbox`, which blanks the browser PDF viewer. No sandbox here.
    if (url.pathname === "/api/sheet/pdf" && req.method === "POST") {
      if (publicReq) return fail(res, 403, "sheet_public", "通过公网访问时不提供表格内容，回本机操作");
      const body = await readBody(req).catch(() => ({}));
      const grant = await resolveSheetGrant(res, String(body.token ?? ""));
      if (!grant) return;
      try {
        return json(res, 200, await sheetPdfStatus(grant.abs, grant.mtimeMs, body.retry === true));
      } catch (err: any) {
        const code = String(err?.code ?? "") || "sheet_pdf_failed";
        return fail(res, code === "sheet_pdf_soffice" ? 503 : 502, code, String(err?.message ?? err));
      }
    }

    if (url.pathname === "/api/sheet/pdf" && req.method === "GET") {
      if (publicReq) return fail(res, 403, "sheet_public", "通过公网访问时不提供表格内容，回本机操作");
      const grant = await resolveSheetGrant(res, url.searchParams.get("token") ?? "");
      if (!grant) return;
      const id = url.searchParams.get("id") ?? "";
      // 只有这张凭据能换出这个 id 对应的 PDF，别人拿不到。
      if (id !== sheetPdfKey(grant.abs, grant.mtimeMs)) return fail(res, 404, "sheet_pdf_gone", "页面视图已失效，请重新生成");
      try {
        const pdf = await sheetPdfFile(id);
        if (!pdf) {
          // 还在转：让前端继续轮询状态端点，别把这条请求吊 180 秒。
          res.writeHead(202, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
          res.end("页面视图还在生成");
          return;
        }
        const size = (await fs.promises.stat(pdf.file)).size;
        res.writeHead(200, {
          "content-type": "application/pdf",
          "content-length": String(size),
          "content-disposition": 'inline; filename="page-view.pdf"',
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        fs.createReadStream(pdf.file).pipe(res);
        return;
      } catch (err: any) {
        const code = String(err?.code ?? "") || "sheet_pdf_failed";
        return fail(res, code === "sheet_pdf_soffice" ? 503 : 502, code, String(err?.message ?? err));
      }
    }

    // D209: 幻灯片翻页的 PDF（PowerPoint 无窗口导出）。和 /api/sheet/pdf 同一套两阶段契约
    // （POST 起转换/查状态，GET 拿字节），也同样**不能**走 /raw —— 那里的 `content-security-policy:
    // sandbox` 会让浏览器内建 PDF 查看器白屏（D166 踩过）。
    if (url.pathname === "/api/slides/pdf" && req.method === "POST") {
      if (publicReq) return fail(res, 403, "slides_public", "通过公网访问时不提供演示文稿内容，回本机操作");
      const body = await readBody(req).catch(() => ({}));
      const grant = await resolveSheetGrant(res, String(body.token ?? ""));
      if (!grant) return;
      try {
        return json(res, 200, await slidesPdfStatus(grant.abs, grant.mtimeMs, body.retry === true));
      } catch (err: any) {
        const code = String(err?.code ?? "") || "slides_pdf_failed";
        return fail(res, code === "slides_pdf_powerpoint" ? 503 : 502, code, String(err?.message ?? err));
      }
    }

    if (url.pathname === "/api/slides/pdf" && req.method === "GET") {
      if (publicReq) return fail(res, 403, "slides_public", "通过公网访问时不提供演示文稿内容，回本机操作");
      const grant = await resolveSheetGrant(res, url.searchParams.get("token") ?? "");
      if (!grant) return;
      const id = url.searchParams.get("id") ?? "";
      // 只有这张凭据能换出这个 id 对应的 PDF。
      if (id !== slidesPdfKey(grant.abs, grant.mtimeMs)) {
        return fail(res, 404, "slides_pdf_gone", "幻灯片视图已失效，请重新生成");
      }
      try {
        const pdf = await slidesPdfFile(id);
        if (!pdf) {
          // 还在转：让前端继续轮询状态端点，不要挂住这条请求。
          res.writeHead(202, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
          res.end("幻灯片还在生成");
          return;
        }
        const size = (await fs.promises.stat(pdf.file)).size;
        res.writeHead(200, {
          "content-type": "application/pdf",
          "content-length": String(size),
          "content-disposition": 'inline; filename="slides.pdf"',
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        fs.createReadStream(pdf.file).pipe(res);
        return;
      } catch (err: any) {
        const code = String(err?.code ?? "") || "slides_pdf_failed";
        return fail(res, code === "slides_pdf_powerpoint" ? 503 : 502, code, String(err?.message ?? err));
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

    /* ── D245 预览里的翻译对照 ──────────────────────────────────────────
     * 译文不进仓库：缓存在状态目录（`statePath("translate", …)`）。翻译跑在独立的 pi 子进程里，
     * 不占当前会话的上下文；写回原文必须走 /sync + /apply，且只改人改过的那几块。
     */
    const trFail = (res: http.ServerResponse, err: any) => {
      const status = Number(err?.status) || 400;
      return fail(res, status, String(err?.code ?? "translate_failed"), String(err?.message ?? err));
    };
    /** 会话 + 路径 → 可翻译的文本文件。公网一律不给：译文也是内容。 */
    const trFile = (body: any) => {
      const sessionId = String(body.sessionId ?? "");
      const where = sessions.locate(sessionId);
      if (!where) throw Object.assign(new Error("找不到这个会话"), { status: 404, code: "session_not_found" });
      const abs = resolvePreviewPath(where, String(body.path ?? ""));
      const kind = kindOf(abs);
      if (kind !== "markdown" && kind !== "text") {
        throw Object.assign(new Error("预览里的翻译只支持 Markdown 和纯文本"), { status: 400, code: "translate_kind" });
      }
      const st = fs.statSync(abs);
      if (!st.isFile()) throw Object.assign(new Error(`不是文件：${abs}`), { status: 400, code: "translate_kind" });
      if (st.size > MAX_TRANSLATE_BYTES) {
        const kb = Math.round(st.size / 1024);
        throw Object.assign(new Error(`文件 ${kb} KB，超过 ${MAX_TRANSLATE_BYTES / 1024} KB 就不在预览里翻了`), {
          status: 400,
          code: "translate_too_large",
        });
      }
      return { sessionId, where, abs, st };
    };

    if (url.pathname === "/api/translate/doc" && req.method === "POST") {
      if (publicReq) return fail(res, 403, "translate_public", "通过公网访问时不提供翻译，回本机操作");
      const body = await readBody(req).catch(() => ({}));
      try {
        const { abs, st } = trFile(body);
        const lang = isTrLang(body.lang) ? body.lang : null;
        if (!lang) return fail(res, 400, "translate_lang", `不支持的语言：${String(body.lang ?? "")}`);
        const doc = readDoc(abs, lang);
        const stale = !doc || Math.abs(doc.mtime - st.mtimeMs) > 0.5 || doc.size !== st.size;
        return json(res, 200, {
          doc,
          stale,
          langs: TR_LANGS,
          mtime: st.mtimeMs,
          size: st.size,
          job: translateJobs.active(abs, lang),
          prefs: readTrPrefs(),
          defaultModel: TR_DEFAULT_MODEL,
        });
      } catch (err: any) {
        return trFail(res, err);
      }
    }

    // 默认用哪个模型翻（D245）：只存本机偏好，跟具体文件无关。
    if (url.pathname === "/api/translate/prefs" && (req.method === "GET" || req.method === "POST")) {
      if (publicReq) return fail(res, 403, "translate_public", "通过公网访问时不提供翻译，回本机操作");
      try {
        // GET 只读（设置页打开时看一眼）；POST 带 `model` 就写，不带就只回显。
        const body = req.method === "POST" ? await readBody(req).catch(() => ({})) : {};
        const prefs = typeof body.model === "string" ? writeTrPrefs({ model: body.model }) : readTrPrefs();
        return json(res, 200, { prefs, defaultModel: TR_DEFAULT_MODEL });
      } catch (err: any) {
        return trFail(res, err);
      }
    }

    if (url.pathname === "/api/translate/start" && req.method === "POST") {
      if (publicReq) return fail(res, 403, "translate_public", "通过公网访问时不提供翻译，回本机操作");
      const body = await readBody(req).catch(() => ({}));
      try {
        const { where, abs, st } = trFile(body);
        const lang = isTrLang(body.lang) ? body.lang : null;
        if (!lang) return fail(res, 400, "translate_lang", `不支持的语言：${String(body.lang ?? "")}`);
        const provider = String(body.provider ?? "").trim();
        const model = String(body.model ?? "").trim();
        if (!provider || !model) return fail(res, 400, "translate_model", "先选一个模型");
        const { text } = readTextFile(abs);
        if (!text.trim()) return fail(res, 400, "translate_empty", "这个文件是空的");
        // 同一个模型下「更新」只补翻变了的节；换了模型就整篇重来（不同模型的译文不该混在一起）。
        const cached = readDoc(abs, lang);
        const reuse = !!cached && cached.provider === provider && cached.model === model && body.force !== true;
        const fast = await sessions.modelsFast().catch(() => []);
        const run = {
          cli: resolvePi().cli,
          cwd: where.cwd,
          lang,
          provider,
          model,
          fast: fast.some((m) => m.provider === provider && m.id === model),
        };
        const job = translateJobs.start({
          text,
          abs,
          rel: String(body.path ?? ""),
          lang,
          run,
          runner: runPiTranslate,
          keep: reuse ? cached.sections : [],
        });
        translateJobs.stamp(job.id, st.mtimeMs, st.size);
        log(`translate ${path.basename(abs)} → ${lang} via ${provider}/${model}${reuse ? " (update)" : ""}`);
        return json(res, 200, { job });
      } catch (err: any) {
        return trFail(res, err);
      }
    }

    if (url.pathname === "/api/translate/job" && req.method === "GET") {
      const job = translateJobs.get(url.searchParams.get("id") ?? "");
      if (!job) return fail(res, 404, "translate_job", "这个翻译任务已经不在表里了");
      return json(res, 200, { job });
    }

    if (url.pathname === "/api/translate/cancel" && req.method === "POST") {
      if (publicReq) return fail(res, 403, "translate_public", "通过公网访问时不提供翻译，回本机操作");
      const body = await readBody(req).catch(() => ({}));
      return json(res, 200, { ok: translateJobs.cancel(String(body.id ?? "")) });
    }

    // 手改译文只落在缓存里（`out` 与机器基线 `gen` 分开存），所以随时能看出「哪几节是人改的」。
    if (url.pathname === "/api/translate/save" && req.method === "POST") {
      if (publicReq) return fail(res, 403, "translate_public", "通过公网访问时不提供翻译，回本机操作");
      const body = await readBody(req).catch(() => ({}));
      try {
        const { abs } = trFile(body);
        const lang = isTrLang(body.lang) ? body.lang : null;
        if (!lang) return fail(res, 400, "translate_lang", `不支持的语言：${String(body.lang ?? "")}`);
        if (typeof body.text !== "string") return fail(res, 400, "translate_text", "译文必须是字符串");
        const doc = readDoc(abs, lang);
        if (!doc) return fail(res, 404, "translate_doc", "还没有译文，先翻一次");
        const cuts = splitSections(body.text);
        if (cuts.length !== doc.sections.length) {
          return fail(
            res,
            400,
            "translate_shape",
            `译文的分节对不上了：原文 ${doc.sections.length} 节，现在 ${cuts.length} 节。标题行别删，不然同步回原文没法定位`,
          );
        }
        const next: TrSection[] = doc.sections.map((sec, i) => ({ ...sec, out: cuts[i] }));
        const out = { ...doc, sections: next };
        writeDoc(out);
        translateJobs.patch(abs, lang, next);
        return json(res, 200, { doc: out });
      } catch (err: any) {
        return trFail(res, err);
      }
    }

    /* 同步回原文分两步：/sync 只算（调模型、给差异），/apply 才写盘。
     * 中间那份待写内容留在桥的内存里，页面拿不到全文，也就没法把别的内容塞进写路径。 */

    if (url.pathname === "/api/translate/sync" && req.method === "POST") {
      if (publicReq) return fail(res, 403, "translate_public", "通过公网访问时不提供翻译，回本机操作");
      const body = await readBody(req).catch(() => ({}));
      try {
        const { where, abs, st } = trFile(body);
        const lang = isTrLang(body.lang) ? body.lang : null;
        if (!lang) return fail(res, 400, "translate_lang", `不支持的语言：${String(body.lang ?? "")}`);
        const doc = readDoc(abs, lang);
        if (!doc) return fail(res, 404, "translate_doc", "还没有译文，先翻一次");
        if (doc.sections.every((sec) => sec.out === sec.gen)) return fail(res, 400, "translate_clean", "译文还没改过，没有要同步的内容");
        const provider = String(body.provider ?? doc.provider).trim();
        const model = String(body.model ?? doc.model).trim();
        const fast = await sessions.modelsFast().catch(() => []);
        const run = {
          cli: resolvePi().cli,
          cwd: where.cwd,
          lang,
          provider,
          model,
          fast: fast.some((m) => m.provider === provider && m.id === model),
        };
        const plan = await planSync(doc, run, runPiTranslate);
        const file = readTextFile(abs);
        const applied = applySync(file.text, plan.edits);
        if (!applied.applied.length) {
          const why = plan.warnings.slice(0, 3).join("；") || "原文已经变了，找不到要改的那一块";
          return fail(res, 400, "translate_sync_empty", `一处也没写回去：${why}`);
        }
        dropStaleApplies();
        const id = randomUUID();
        pendingApply.set(id, { abs, lang, mtime: st.mtimeMs, size: st.size, text: applied.text, enc: file.enc, bom: file.bom, at: Date.now() });
        // 页面只给个「改了哪几块」的预览：整篇 before/after 可能有几百 KB，没必要来回搬。
        const clip = (t: string): string => {
          const lines = t.split("\n");
          const kept = lines.length > 8 ? [...lines.slice(0, 8), "…"] : lines;
          const one = kept.join("\n");
          return one.length > 800 ? `${one.slice(0, 800)}…` : one;
        };
        return json(res, 200, {
          id,
          edits: applied.applied.length,
          missing: applied.missing.length,
          warnings: plan.warnings,
          preview: applied.applied.slice(0, 20).map((e) => ({ before: clip(e.before), after: clip(e.after) })),
        });
      } catch (err: any) {
        return trFail(res, err);
      }
    }

    if (url.pathname === "/api/translate/apply" && req.method === "POST") {
      if (publicReq) return fail(res, 403, "translate_public", "通过公网访问时不提供翻译，回本机操作");
      const body = await readBody(req).catch(() => ({}));
      const plan = pendingApply.get(String(body.id ?? ""));
      if (!plan) return fail(res, 404, "translate_apply", "这次同步已经过期了，重新点一次「同步」");
      try {
        const st = fs.statSync(plan.abs);
        if (Math.abs(st.mtimeMs - plan.mtime) > 0.5 || st.size !== plan.size) {
          return fail(res, 409, "translate_conflict", "文件在你同步期间被改过了，重新点一次「同步」");
        }
        // 写前留一份原文备份：同步是机器改人的文件，比手动保存更该能退回去。
        const bak = statePath("translate", "backup", `${path.basename(plan.abs)}.${Date.now()}.bak`);
        fs.mkdirSync(path.dirname(bak), { recursive: true });
        fs.copyFileSync(plan.abs, bak);
        writeTextFile(plan.abs, plan.text, plan.enc, plan.bom);
        pendingApply.delete(String(body.id ?? ""));
        const after = fs.statSync(plan.abs);
        // 写回之后原文就是这份译文里「有改动的地方」了：把缓存里的 src 换成新原文，gen 归到当前
        // 译文。不更新的话对照页左边还挂着翻译那一刻的快照，用户看到的是「提示写回了，左边没变」。
        const doc = readDoc(plan.abs, plan.lang);
        if (doc) {
          const cuts = cutSections(plan.text);
          let note = "";
          if (cuts.length === doc.sections.length) {
            const next = doc.sections.map((sec, i) => ({ heading: cuts[i].heading, src: cuts[i].text, gen: sec.out, out: sec.out }));
            writeDoc({ ...doc, mtime: after.mtimeMs, size: after.size, sections: next });
            translateJobs.patch(plan.abs, plan.lang, next);
          } else {
            // 结构对不齐（模型在写回时多/少写了标题行）：译文按新原文重翻，别拿旧快照冒充。
            note = `写回后分节变了（${doc.sections.length} → ${cuts.length}），译文要重翻一次`;
            writeDoc({ ...doc, mtime: after.mtimeMs, size: after.size, warnings: [...doc.warnings, note] });
          }
        }
        log(`translate sync → ${plan.abs} (backup ${bak})`);
        return json(res, 200, { path: plan.abs, mtime: after.mtimeMs, size: after.size, backup: bak });
      } catch (err: any) {
        return trFail(res, err);
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

    // D166/#106 出口: hand the previewed workbook to this desktop's own program (Excel). The action
    // happens on the desktop, not in the browser, so a tunnel visitor is refused outright. The path is
    // taken from the grant alone — a page that already read the file still cannot open anything else.
    if (url.pathname === "/api/open" && req.method === "POST") {
      if (publicReq) return fail(res, 403, "open_public", "通过公网访问时不会在你电脑上打开文件，回本机操作");
      const body = await readBody(req).catch(() => ({}));
      const grant = await resolveSheetGrant(res, String(body.token ?? ""));
      if (!grant) return;
      const out = openWithApp(grant.abs);
      log(`open ${grant.abs} → ${out.ok ? "ok" : out.message}`);
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

    // 会话里的一枚图片（点开缩略图）。条目正文里只有 mimeType，字节按条目 id 从会话文件流式读；
    // 刚发出、还没落盘的 `user:N` 气泡由桥内存里那份兜底。
    if (url.pathname === "/api/session/image" && req.method === "GET") {
      const id = url.searchParams.get("id") ?? "";
      const item = url.searchParams.get("item") ?? "";
      const index = Number(url.searchParams.get("n"));
      if (!Number.isInteger(index) || index < 0) return fail(res, 400, "bad_image_index", "图片序号不对");
      if (!sessions.locate(id)) return fail(res, 404, "session_not_found", "找不到这个会话");
      try {
        const img = await sessions.image(id, item, index);
        if (!img) return fail(res, 404, "image_not_found", "这张图片在会话文件里已经找不到了");
        res.writeHead(200, {
          "content-type": img.mimeType,
          "content-length": String(img.data.length),
          // 条目写进文件就不会再变；同一张图重复渲染不必再问一次桥。
          "cache-control": "private, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        });
        res.end(img.data);
        return;
      } catch (err: any) {
        return fail(res, 500, "image_read_failed", `读不了这张图片：${String(err?.message ?? err).slice(0, 200)}`);
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

    // `/changelog` (#26): what is new in the installed pi; `scope=self` is this project's own
    // log (D195), read from `<检出>/CHANGELOG.md` — the two are different documents.
    if (url.pathname === "/api/changelog" && req.method === "GET") {
      if (url.searchParams.get("scope") === "self") return json(res, 200, await selfChangelog());
      return json(res, 200, { version: piVersion, text: changelog(pi.cli) });
    }

    // 本项目需要什么（pi 够不够新、三个扩展在不在）。只读、只问本地 `pi list`，页面每次打开
    // 设置都敢问一遍；真正的安装是 `npm install` 的 postinstall（scripts/bootstrap.mjs）。
    if (url.pathname === "/api/deps" && req.method === "GET") {
      return json(res, 200, await depsReport(pi.cli, piVersion));
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
        return json(res, 200, { tunnel: tunnel.state });
      }
      if (body.action !== "stop") return json(res, 200, { tunnel: tunnel.state });
      // 公网页面点「关掉公网隧道」时，这个请求是**穿过 cloudflared** 才到这里的：回包也得穿回去。
      // 先 stop 的话 cloudflared 当场死掉，浏览器拿到的是 Cloudflare 的 502 HTML，页面只能停在旧状态
      // ——用户看到的就是「点了没反应」。所以先把响应写出去，隔 TUNNEL_STOP_GRACE_MS 再停。
      const off: TunnelState = { ...tunnel.state, status: "off", url: null, error: null, updatedAt: Date.now() };
      json(res, 200, { tunnel: off });
      // 定时器不挂在 `res.end` 的回调上：socket 已经断了的时候那个回调根本不触发，隧道就永远不停
      // （而断掉的 socket 正是公网页面最常见的现场）。晚一点无所谓，不停才是 bug。
      setTimeout(() => tunnel.stop(), TUNNEL_STOP_GRACE_MS).unref?.();
      return;
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
      const client = ws as ClientSocket;
      client.publicReq = isTunnelRequest(req.headers);
      client.stepUntil = client.publicReq ? 0 : Number.MAX_SAFE_INTEGER;
      wss.emit("connection", ws, req);
    });
  });

  /** 升级时记在连接上的两件事：是不是从隧道来的（D215）、首帧要不要按步下发。 */
  type ClientSocket = WebSocket & { publicReq?: boolean; stepUntil?: number };

  /**
   * #218 补：分页只是**隧道上的传输优化**，不是新的存储模型。本机 / 内网连接照旧整段下发 ——
   * 切回会话立刻是完整历史，不用再一页页点「载入更早」；只有穿过 cloudflared 的连接吃分页。
   * `PI_WEB_PAGE_ALL=1` 让本机连接也分页，UI 用例靠它覆盖翻页那条路（见 history-ui / history-paths-ui）。
   */
  const pageAll = process.env.PI_WEB_PAGE_ALL === "1";
  const pagedFor = (client: WebSocket): boolean => pageAll || Boolean((client as ClientSocket).publicReq);

  /**
   * 一帧整页历史按**连接**成形：分页连接是末尾一页，其余整段。`session`（单播）与 `items`（广播）
   * 共用这一处 —— 形状跟着连接走，不跟着会话走，否则同一条会话在两个标签页里只能二选一。
   */
  const frameFor = (client: WebSocket, payload: any): any => {
    if (pagedFor(client) || !payload?.history) return payload;
    if (payload.type !== "session" && payload.type !== "items") return payload;
    const session = sessions.get(String(payload.sessionId ?? ""));
    if (!session) return payload;
    return { ...payload, ...session.frame({ full: true }) };
  };

  /**
   * 一条会话的 `session` 帧：subscribe / claim / create / reload 四条路径共用这一处，
   * `trust` 由调用方补 —— 形状（隧道一页 / 本机整段）交给 `frameFor`（D215）。
   */
  const sessionFrameOf = (snap: { state: { id: string } }) => ({ type: "session", sessionId: snap.state.id, ...snap });

  const broadcast = (payload: any) => {
    // 整页帧只会有两种形状（隧道一页 / 本机整段），每份只序列化一次；其余帧所有连接共用一份字节。
    const cache = new Map<"paged" | "full", string>();
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const shaped = frameFor(client as WebSocket, payload);
      const key = shaped === payload ? "paged" : "full";
      let data = cache.get(key);
      if (data === undefined) cache.set(key, (data = JSON.stringify(shaped)));
      client.send(data);
    }
  };

  // D81/D171: the MCP store's ranked index is a walk over hundreds of registry pages. Tell the page
  // when it lands, so the unranked registry results it was shown get replaced without a re-search.
  setIndexListener((idx) => broadcast({ type: "mcp.index", at: idx.at, truncated: Boolean(idx.truncated) }));

  /**
   * D150 · 两段式目录：先用 `-ne` 的快清单把面板填上（1–2 s），带扩展的完整清单落地后再补一次。
   * 只发内容真变了的那一份（`catalogSig`），因为面板开着时用户可能已经在挑模型，拿同一份列表
   * 重画会把挑了一半的选项退回去。失败不再静默成空列表：记日志，并且只有一份都没拿到时才告诉
   * 前端 error（前端据此把「稍等一下」改成「没读出来，点这里重试」）。
   */
  const catalogSigOf = (list: { provider: string; id: string }[]) => list.map((m) => `${m.provider}/${m.id}`).join("\n");
  /**
   * 每条连接各记一份「这条连接已经拿到哪一份目录」。用全局签名会踩一个坑：先连上来的那条（比如刚
   * 建完会话就断开的标签页）把完整清单「吃掉」，之后进来的页面就永远只剩快清单（D150 现场踩到过）。
   * 键必须是 socket 本身：广播时每条连接都会现造一个新的 send 闭包，挂在闭包上等于每次都是新的。
   */
  const sentCatalog = new WeakMap<WebSocket, { sig: string; full: boolean }>();
  /** `resend` = 这条连接明确再要一次（忽略「没变」）；`bustCache` = 连缓存一起作废（用户点了重试）。 */
  const pushCatalog = async (
    socket: WebSocket,
    opts: { resend?: boolean; bustCache?: boolean } = {},
  ): Promise<void> => {
    const target = (payload: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    };
    const failed: string[] = [];
    const take = (err: unknown) => {
      const message = String((err as any)?.message ?? err);
      failed.push(message);
      log(`catalog: ${message}`);
      return [] as Awaited<ReturnType<typeof sessions.models>>;
    };
    const seen = () => sentCatalog.get(socket);
    const fast = await sessions.modelsFast(opts.bustCache).catch(take);
    const fastSig = fast.length ? catalogSigOf(fast) : "";
    // 已经拿到完整清单的连接别再降级补一份快清单：那会让面板把挑了一半的选项退回去。
    if (fastSig && !seen()?.full && (opts.resend || seen()?.sig !== fastSig)) {
      sentCatalog.set(socket, { sig: fastSig, full: false });
      target({ type: "catalog", models: fast, phase: "fast" });
    }
    const full = await sessions.models(opts.bustCache).catch(take);
    const fullSig = full.length ? catalogSigOf(full) : "";
    if (fullSig) {
      const changed = seen()?.sig !== fullSig;
      sentCatalog.set(socket, { sig: fullSig, full: true });
      if (changed) target({ type: "catalog", models: full, phase: "full" });
    }
    if (!fast.length && !full.length) {
      // 两条都空才推空态。没有异常也必须给个理由，否则面板又只剩「还没加载好」那句。
      target({ type: "catalog", models: [], error: failed[0] ?? "pi 没返回任何模型（可能还没登录任何 provider）" });
    }
    // 一行说清这趟拿到了什么：这次报障最贵的地方就是「界面空着、日志也空着」。
    log(`catalog: fast ${fast.length} / full ${full.length}${failed.length ? ` / 失败 ${failed.join("；")}` : ""}`);
  };
  /** 广播一份新目录：逐条连接各自算「变了没」，否则一次广播只有第一条能收到。 */
  const refreshCatalog = (bustCache: boolean): void => {
    for (const client of wss.clients) void pushCatalog(client as WebSocket, { bustCache });
  };

  // Terminals live in the bridge, not in a connection: a page reload re-attaches and replays output.
  const terminals = new Terminals({
    onData: (id, data) => broadcast({ type: "term.data", id, data }),
    onExit: (id, code) => broadcast({ type: "term.exit", id, code }),
  });

  sessions.on("ws", broadcast);
  /**
   * 状态文件读不到：在聊天区说一句。读不到的这次改动不会落盘（见 statefile.ts），但界面上它已经生效了 ——
   * 不吭声就是假成功：用户拖完置顶、重启一看全没了。同一句错只报一次（去重在 StateFile 里）。
   */
  const stateUnreadable = (failure: StateFailure) => {
    const name = path.basename(failure.file);
    log(`state: 读不到 ${failure.file}（${failure.error}）`);
    broadcast({
      type: "notice",
      level: "error",
      code: "state_file_unreadable",
      text: `读不到状态文件 ${name}，这次的改动没有保存`,
      params: { p1: name },
    });
  };
  sessions.manage.onUnreadable = stateUnreadable;
  sessions.workspaces.onUnreadable = stateUnreadable;
  /**
   * D120: the panel stays live without a timer of its own, but only pages that actually asked for
   * the numbers get the tick's broadcast — a 60 s push to every idle tab is nobody's feature.
   */
  const broadcastRuntime = (stats: RuntimeStats) => {
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
    const childWatches = new Map<string, ChildWatch>();
    const childWatchKey = (sessionId: string, runId: string) => `${sessionId}\u0000${runId}`;
    const stopChildWatch = (key: string) => {
      const watch = childWatches.get(key);
      if (!watch) return;
      clearInterval(watch.timer);
      childWatches.delete(key);
    };
    const stopChildWatches = (sessionId?: string) => {
      for (const [key, watch] of childWatches) {
        if (sessionId === undefined || watch.sessionId === sessionId) stopChildWatch(key);
      }
    };
    const pollChildWatch = (watch: ChildWatch, initial = false) => {
      const session = sessions.get(watch.sessionId);
      const child = session?.bgChildSession(watch.runId);
      if (!session || !child) {
        send({ type: "exec.child.unavailable", sessionId: watch.sessionId, runId: watch.runId, error: "run" });
        stopChildWatch(childWatchKey(watch.sessionId, watch.runId));
        return;
      }
      let items = watch.items;
      let plan = watch.plan;
      let stats = watch.stats;
      let file = child.sessionFile ? resolveChildSessionFile(child.sessionFile) ?? null : null;
      let size = watch.size;
      let mtime = watch.mtime;
      if (!file && watch.file) {
        send({ type: "exec.child.unavailable", sessionId: watch.sessionId, runId: watch.runId, error: "session-file" });
        stopChildWatch(childWatchKey(watch.sessionId, watch.runId));
        return;
      }
      if (file) {
        try {
          const stat = fs.statSync(file);
          if (file !== watch.file || stat.size !== watch.size || stat.mtimeMs !== watch.mtime) {
            const loaded = loadEntries(file);
            const replay = planReplayFromEntries(loaded.entries);
            items = entriesToItems(loaded.entries, replay.toolResults);
            plan = replay.plan;
            stats = childSessionStats(loaded.entries);
            size = stat.size;
            mtime = stat.mtimeMs;
          }
        } catch {
          file = null;
        }
      }
      const state = child.run.state;
      const ids = watch.items.map((item) => item.id);
      const nextIds = items.map((item) => item.id);
      const reset = ids.some((id, index) => nextIds[index] !== id);
      const oldItems = new Map(watch.items.map((item) => [item.id, JSON.stringify(item)]));
      const changed = reset ? items : items.filter((item) => oldItems.get(item.id) !== JSON.stringify(item));
      const changedAnything = initial || changed.length > 0 || state !== watch.state || JSON.stringify(plan) !== JSON.stringify(watch.plan) || JSON.stringify(stats) !== JSON.stringify(watch.stats) || file !== watch.file;
      watch.file = file;
      watch.size = size;
      watch.mtime = mtime;
      watch.items = items;
      watch.plan = plan;
      watch.stats = stats;
      watch.state = state;
      if (!changedAnything) return;
      send({
        type: initial ? "exec.child.snapshot" : "exec.child.delta",
        sessionId: watch.sessionId,
        runId: watch.runId,
        toolCallId: child.run.toolCallId,
        state,
        items: initial || reset ? items : changed,
        plan,
        stats,
        ...(reset && !initial ? { reset: true } : {}),
        pending: !file && state === "running",
      });
    };
    send({
      type: "hello",
      version: VERSION,
      buildId: BUILD_ID,
      pi: piVersion,
      sessions: sessions.list(),
      manage: sessions.manage.snapshot(),
      workspace: sessions.workspaces.snapshot(),
      trash: sessions.trashList(),
      tunnel: tunnel.state,
      public: (ws as any).publicReq,
      ui: readUiPrefs(),
      notes: listNotes(),
      // #278：页面据此决定 ＋ 是「挑目录建组」还是退回「空壳组 + 就地改名」（旧桥没有这项）；
      // `ws.resolve.dir` = 对话框能问「这个目录折回到哪个组」（子目录 / worktree）。
      caps: ["ws.create.dir", "ws.resolve.dir", "exec.child.subscribe"],
    });
    // 先用 1–2 s 的快清单打招呼，带扩展的完整清单十几秒后自己补上（D150）。
    void pushCatalog(ws, { resend: true });
    log(`ws connected from ${clientIp(req.headers, req.socket.remoteAddress)}${(ws as any).publicReq ? " (tunnel)" : ""}`);

    const requireStepUp = async (): Promise<boolean> => {
      if (Date.now() < (ws as any).stepUntil) return true;
      send({ type: "need-stepup" });
      return false;
    };

    /**
     * manage 的广播一律带上工作区快照（#94）：前端拿到的会话、分组、置顶是同一时刻的一份状态，
     * 否则一次拖排之后两个列表会互相打架。
     */
    const manageSnapshot = () => ({ manage: sessions.manage.snapshot(), workspace: sessions.workspaces.snapshot() });

    /**
     * 补一次工作区缓存（git 是子进程，慢），有改动才广播。页面进来时跑一次：worktree 在这时候
     * 才并回主仓，于是分组从「按 cwd 暂时分的」变成真的。
     */
    const syncWorkspaces = async (): Promise<void> => {
      try {
        if (!(await sessions.resolveWorkspaces())) return;
        broadcast({ type: "workspaces", workspace: sessions.workspaces.snapshot() });
        broadcast({ type: "sessions.list", sessions: sessions.list(), workspace: sessions.workspaces.snapshot() });
      } catch {
        /* 补缓存失败只影响分组精度，不影响会话本身 */
      }
    };
    void syncWorkspaces();

    // A login waiting on this page's answers (or an OAuth callback server) must not outlive it.
    ws.on("close", () => {
      stopChildWatches();
      dropClient(ws);
      // 这条链接上还没回执的投递再也不会有人接：结算成 no-ack，别把 HTTP 请求挂到超时。
      for (const entry of pendingPreview.values()) {
        if (entry.ws === ws) entry.settle({ ok: false, reason: "no-ack" });
      }
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
            // `ttl` 是相对时长：手机时钟偏快/偏慢时，按绝对值算的 until 会让前端提前或滞后弹窗。
            send({ type: "stepup-ok", until: (ws as any).stepUntil, ttl: STEP_UP_MS });
            return;
          }
          case "models": {
            // 面板打开时自己补问一次（只吃缓存）；点了「点这里重试」才带 force，把两段缓存一起作废。
            void pushCatalog(ws, { resend: true, bustCache: (msg as { force?: boolean }).force === true });
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
            const sid = String(msg.sessionId);
            for (const [key, watch] of childWatches) if (watch.sessionId !== sid) stopChildWatch(key);
            const snap = sessions.pagedSnapshot(sid);
            (ws as any).watching = sid;
            send(frameFor(ws, { ...sessionFrameOf(snap), trust: await trustFor(snap.state.cwd) }));
            void sessions.get(String(msg.sessionId))?.refreshStats();
            return;
          }
          /**
           * #220：往前翻一页。纯内存切片 —— 不读盘、不碰 pi，所以点一下就能回。
           * `limit` 由 `pageBefore()` 夹在 [1, 60]；`before` 不在这个会话里就回空页 + hasMore:false。
           */
          case "history.before": {
            const session = sessions.get(String(msg.sessionId));
            const page = session ? pageBefore(session.items, String(msg.before ?? ""), msg.limit) : { items: [], hasMore: false };
            send({ type: "history", sessionId: msg.sessionId, before: msg.before, items: page.items, hasMore: page.hasMore });
            return;
          }
           case "exec.child.subscribe": {
             const sessionId = String(msg.sessionId ?? "");
             const runId = String(msg.runId ?? "").slice(0, 100);
             if ((ws as any).publicReq) {
               send({ type: "exec.child.unavailable", sessionId, runId, error: "public" });
               return;
             }
             const session = sessions.get(sessionId);
             if (!runId || !session?.bgChildSession(runId)) {
               send({ type: "exec.child.unavailable", sessionId, runId, error: "run" });
               return;
             }
             const key = childWatchKey(sessionId, runId);
             stopChildWatch(key);
             let watch: ChildWatch;
             const timer = setInterval(() => pollChildWatch(watch), 1000);
             watch = { sessionId, runId, timer, file: null, size: -1, mtime: -1, items: [], plan: null, stats: null, state: "unknown" };
             childWatches.set(key, watch);
             pollChildWatch(watch, true);
             return;
           }
           case "exec.child.unsubscribe": {
             stopChildWatch(childWatchKey(String(msg.sessionId ?? ""), String(msg.runId ?? "").slice(0, 100)));
             return;
           }
           case "unsubscribe": {
             // Closing the parent session view also releases its private child-session polling watches.
             const sid = String(msg.sessionId);
             stopChildWatches(sid);
             // 页面关掉会话 = 不再「在看」它（#224 复审）：只清自己这一格，同会话的其它页签照旧收投递。
             if ((ws as any).watching === sid) (ws as any).watching = null;
             return;
           }
          case "preview.open.done": {
            // 页面对一条 `preview.open` 的回应（#224 复审）：只有投给**这条 ws** 的 reqId 才认。
            const entry = pendingPreview.get(String(msg.reqId ?? ""));
            if (!entry || entry.ws !== ws) return;
            entry.settle({
              ok: msg.ok === true,
              reason: msg.ok === true ? undefined : String(msg.reason ?? ""),
              text: msg.text ? String(msg.text) : undefined,
            });
            return;
          }
          case "claim": {
            if (!(await requireStepUp())) return;
            const session = await sessions.claim(String(msg.sessionId));
            (ws as any).watching = session.state.id;
            send(frameFor(ws, { ...sessionFrameOf(session.pagedSnapshot()), trust: await trustFor(session.state.cwd) }));
            return;
          }
          case "prompt": {
            if (!(await requireStepUp())) return;
            const sessionId = String(msg.sessionId);
            const text = String(msg.text ?? "");
            const images = msg.images as { data: string; mimeType: string }[] | undefined;
            const clientId = typeof msg.clientId === "string" ? msg.clientId.slice(0, 80) : undefined;
            const behavior = msg.behavior === "followUp" ? "followUp" : "steer";
            if (sessions.isPausedScratch(sessionId)) {
              send({ type: "notice", sessionId, code: "scratch_paused", text: "已暂停", level: "warn" });
              return;
            }
            // #201: 只读会话发消息 = 自动接管，但气泡必须在 `openLive()`（拉起 pi、等 get_state）
            // **之前**广播出去，否则一句刚打的字要等整个握手。消息进的是会话自己的待发队列 —— 与
            // 启动窗口、接管后再打字是同一条，所以撤回/失败/连发都复用同一套。
            const queued = sessions.acceptBeforeOpen(sessionId, text, images, clientId, behavior);
            try {
              const session = await sessions.openLive(sessionId);
              // 人开口了：上一轮「⚡ 复盘」到此结束，D169 的当场叫住重新生效。
              session.reviewing = false;
              // 已经在队列里了（上面那一行），别再落一枚气泡。
              if (queued === null) await session.prompt(text, images, clientId, behavior);
            } catch (err) {
              // 自动接管没成（终端里的 pi 还开着、会话起不来）：气泡标红，原因照旧由下面那句 notice 说。
              if (queued !== null) sessions.get(sessionId)?.failBeforeBoot(queued);
              throw err;
            }
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
          case "scratch.open": {
            // #86: idempotent — creates on first use, wakes it after a sleep, otherwise reuses.
            // No step-up: it creates nothing the page can steer (cwd, tools and session dir are all
            // the bridge's own choice), and `prompt` is not gated either.
            const session = await sessions.scratchSession();
            (ws as any).watching = session.state.id;
            send({ type: "scratch", sessionId: session.state.id, ...session.snapshot(), trust: null });
            return;
          }
          case "scratch.clear": {
            // Same process, fresh session: no cold start, and the token count starts over.
            const session = await sessions.clearScratch();
            (ws as any).watching = session.state.id;
            send({ type: "scratch", sessionId: session.state.id, ...session.snapshot(), trust: null });
            return;
          }
          case "scratch.pause": {
            const session = await sessions.pauseScratch();
            (ws as any).watching = session.state.id;
            send({ type: "scratch", sessionId: session.state.id, ...session.snapshot(), trust: null });
            return;
          }
          case "scratch.resume": {
            const session = await sessions.resumeScratch();
            (ws as any).watching = session.state.id;
            send({ type: "scratch", sessionId: session.state.id, ...session.snapshot(), trust: null });
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
            send(frameFor(ws, { ...sessionFrameOf(session.pagedSnapshot()), trust: await trustFor(session.state.cwd) }));
            broadcast({ type: "session.state", session: session.state });
            if (msg.pin) broadcast({ type: "manage", ...manageSnapshot() });
            return;
          }
          case "mkdir": {
            // New-session folder picker + 文件管理器 / 附件弹层: one level, under a folder the user is browsing.
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
          case "mkfile": {
            // D167: 新文件是**空文件**；覆盖永远不会发生（makeFile 用 `wx`），同名就报「已经存在」。
            if (!(await requireStepUp())) return;
            const reqId = String(msg.reqId ?? "");
            try {
              const created = makeFile(String(msg.parent ?? ""), String(msg.name ?? ""));
              log(`mkfile ${created}`);
              send({ type: "mkfile.result", reqId, path: created });
            } catch (err: any) {
              send({ type: "mkfile.result", reqId, error: String(err?.message ?? err) });
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
          // ------------------------------------------------ 默认权限（D161）
          case "permission.defaults": {
            // A bad cwd or an unreadable settings file must not take the socket handler down.
            try {
              const cwd = msg.cwd ? String(msg.cwd) : null;
              const d = await defaultPermission(pi.cli, cwd);
              send({ type: "permission.defaults", cwd, mode: d.mode, source: d.source, path: d.path, ...sessions.permissionDefaultSessions(cwd) });
            } catch (err) {
              log(`permission.defaults failed: ${String(err)}`);
              send({ type: "permission.defaults", cwd: msg.cwd ? String(msg.cwd) : null, mode: "ask", source: "fallback", path: null, total: 0 });
            }
            return;
          }
          case "permission.applyDefault": {
            if (!(await requireStepUp())) return;
            try {
              const cwd = msg.cwd ? String(msg.cwd) : null;
              const applied = await sessions.applyDefaultPermission(cwd);
              log(`default permission applied to ${applied} session(s)`);
              send({ type: "permission.applied", cwd, applied });
            } catch (err) {
              log(`permission.applyDefault failed: ${String(err)}`);
              send({ type: "permission.applied", cwd: msg.cwd ? String(msg.cwd) : null, applied: 0 });
            }
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
          // ------------------------------------------------ 后台子代理的详情 (D170)
          case "bg.list": {
            const sid = String(msg.sessionId ?? "");
            // 和 `bg.log` 同一条底线：公网那只读历史的手不该看得到本机的 prompt（`task` 就是派活原话）。
            if ((ws as any).publicReq) {
              send({ type: "bg.list", sessionId: msg.sessionId ?? null, runs: [], error: "public" });
              return;
            }
            send({ type: "bg.list", sessionId: msg.sessionId ?? null, runs: sessions.get(sid)?.bgList() ?? [] });
            return;
          }
          case "bg.log": {
            // 读临时目录里的 runner 痕迹。公网那只读历史的手不该看得到本机的 prompt 与命令输出。
            const sid = String(msg.sessionId ?? "");
            const runId = String(msg.runId ?? "").slice(0, 80);
            if ((ws as any).publicReq) {
              send({ type: "bg.log", sessionId: msg.sessionId ?? null, runId });
              return;
            }
            const limit = Math.min(200_000, Math.max(1000, Number(msg.limit) || 8000));
            send({ type: "bg.log", sessionId: msg.sessionId ?? null, runId, ...(sessions.get(sid)?.bgLog(runId, limit) ?? {}) });
            return;
          }
          // ------------------------------------------------ 技能商店 (D126)
          case "skill.store": {
            // Read-only (a search), so the tunnel may ask too: nothing is written and the bridge
            // only forwards the public directory's own answer. Two stages, like the 扩展 manager
            // (D113): the ranked list goes out immediately, the descriptions when they land.
            const limit = Math.min(50, Math.max(1, Number(msg.limit) || 20));
            const query = String(msg.query ?? "");
            try {
              const ranked = await searchSkillStore(query, limit);
              send({ type: "skill.store", query, ...ranked });
              void describeStoreSkills(ranked.items)
                .then((more) => send({ type: "skill.store.meta", query, ...more }))
                .catch(() => {});
            } catch (err: any) {
              send({ type: "skill.store", query, items: [], error: String(err?.message ?? err), errCode: "skill_store_failed" });
            }
            return;
          }
          case "skill.installed": {
            const cwd = msg.cwd ? String(msg.cwd) : null;
            try {
              send({ type: "skill.installed", cwd, items: installedSkills(cwd) });
            } catch (err: any) {
              send({ type: "skill.installed", cwd, items: [], error: String(err?.message ?? err), errCode: "skill_scan_failed" });
            }
            return;
          }
          case "skill.source": {
            // 按地址安装: list the skills inside a repo or a local directory (no writes).
            const source = String(msg.source ?? "");
            try {
              const preview = await previewSource(source);
              send({ type: "skill.source", ...preview, query: source });
            } catch (err: any) {
              send({ type: "skill.source", source, items: [], error: String(err?.message ?? err), errCode: "skill_source_failed" });
            }
            return;
          }
          case "skill.install": {
            const reqId = typeof msg.reqId === "string" ? msg.reqId.slice(0, 60) : null;
            if ((ws as any).publicReq) {
              send({ type: "skill.install.done", reqId, ok: false, error: "通过公网访问时只能查看，安装 / 卸载技能请在本机或局域网操作", errCode: "skill_public" });
              return;
            }
            if (!(await requireStepUp())) return;
            const scope: "user" | "project" = msg.scope === "project" ? "project" : "user";
            const cwd = msg.cwd ? String(msg.cwd) : null;
            const req = {
              source: msg.source ? String(msg.source) : undefined,
              dir: typeof msg.dir === "string" ? msg.dir : undefined,
              skillId: msg.skillId ? String(msg.skillId) : undefined,
              local: msg.local ? String(msg.local) : undefined,
              name: msg.name ? String(msg.name) : undefined,
              scope,
              cwd,
            };
            log(`skill install ${JSON.stringify({ ...req, reqId: undefined })}`);
            // One writer at a time: two installs into the same skill root must not interleave, and
            // neither must an install and an uninstall of the same folder.
            try {
              const out = await writeLock("skills", () => installSkill(req));
              send({ type: "skill.install.done", reqId, ok: true, ...out });
            } catch (err: any) {
              send({ type: "skill.install.done", reqId, ok: false, error: String(err?.message ?? err), errCode: "skill_install_failed" });
            }
            return;
          }
          case "skill.remove": {
            const reqId = typeof msg.reqId === "string" ? msg.reqId.slice(0, 60) : null;
            if ((ws as any).publicReq) {
              send({ type: "skill.remove.done", reqId, ok: false, error: "通过公网访问时只能查看，安装 / 卸载技能请在本机或局域网操作", errCode: "skill_public" });
              return;
            }
            if (!(await requireStepUp())) return;
            const target = String(msg.path ?? "");
            log(`skill remove ${target}`);
            try {
              const out = await writeLock("skills", async () => removeSkill(target));
              send({ type: "skill.remove.done", reqId, ok: true, ...out });
            } catch (err: any) {
              send({ type: "skill.remove.done", reqId, ok: false, path: target, error: String(err?.message ?? err), errCode: "skill_remove_failed" });
            }
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
          // 设置 → 子代理（#212）：只读磁盘。没装包 / 目录不在都走空结果 + errors，不回 error 帧 ——
          // 这一页的「空」本身就是一种要展示的状态。
          case "subagents.agents": {
            const cwd = String(msg.cwd ?? "") || null;
            try {
              send({ type: "subagents.agents", ...scanSubagents({ cwd }) });
            } catch (err: any) {
              send({ type: "subagents.agents", cwd, installed: false, agents: [], directories: [], errors: [String(err?.message ?? err)] });
            }
            return;
          }
          // 设置 → 子代理 → acp_delegate（#215）：这一半写的是 billion-context 自己的配置文件，
          // 和 settings.set 是两份文件、两条 RPC。读回「读不懂」也只是一种要展示的状态（带 error +
          // 路径），不阻断设置页的其它 tab；写不进去才回 `.error`。
          case "subagents.acp.get": {
            try {
              send({ type: "subagents.acp", ...readAcpDelegate() });
            } catch (err: any) {
              send({ type: "subagents.acp.error", path: acpConfigPath(), message: String(err?.message ?? err) });
            }
            return;
          }
          case "subagents.acp.set": {
            if (!(await requireStepUp())) return;
            try {
              const view = writeAcpDelegate(msg.patch);
              log(`acp_delegate written: ${view.path}`);
              send({ type: "subagents.acp", ...view, saved: true });
            } catch (err: any) {
              send({ type: "subagents.acp.error", path: acpConfigPath(), message: String(err?.message ?? err) });
            }
            return;
          }
          // #375：同一份文件里的 compress.neverPreserveRecentTools 绕法，只有应用 / 撤销两个动作。
          case "subagents.acp.thinkingFix": {
            if (!(await requireStepUp())) return;
            try {
              const view = writeThinkingFix(msg.apply);
              log(`billion-context thinking fix ${msg.apply ? "applied" : "removed"}: ${view.path}`);
              send({ type: "subagents.acp", ...view, saved: "thinkingFix" });
            } catch (err: any) {
              send({ type: "subagents.acp.error", path: acpConfigPath(), message: String(err?.message ?? err) });
            }
            return;
          }
          // ---------------------------------------------------------------- 口令（#89）
          // 明文回显也坐在 step-up 上：D15 里公网连接「能看能读」，而口令明文读一次就等于
          // 拿到全部控制权 —— 读它不能比改它便宜。本机 / 局域网没有这道负担（stepUntil 一开
          // 就是 MAX_SAFE_INTEGER，requireStepUp 直接放行）。
          case "passphrase.get": {
            if (!(await requireStepUp())) return;
            send({ type: "passphrase", value: currentPassphrase(), dir: stateDir() });
            return;
          }
          // 「随机生成一个」只把候选值递给页面，不落盘：误触不该把门锁换了，保存才是写入。
          // 词表与首次启动打印的那串同源（auth.ts 的 generatePassphrase），不在这里再抄一遍。
          case "passphrase.suggest": {
            send({ type: "passphrase.suggest", value: generatePassphrase() });
            return;
          }
          case "passphrase.set": {
            if (!(await requireStepUp())) return;
            const value = String(msg.value ?? "").trim();
            // 与 `--passphrase` 同一个门槛，不出现「命令行收、网页不收」这种两套规矩。
            if (value.length < 4) {
              send({ type: "passphrase.error", message: "口令至少 4 个字符" });
              return;
            }
            setPassphrase(value);
            log(`passphrase changed from ${clientIp(req.headers, req.socket.remoteAddress)}`);
            // 只广播「变了」，不广播明文：否则公网只读连接可以绕过上面那道 step-up。
            broadcast({ type: "passphrase.changed" });
            send({ type: "passphrase", value, dir: stateDir(), saved: true });
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
          // D120 / #78: the one write the runtime panel has — the two thresholds, into
          // `lifecycle.json` so a restarted bridge keeps them. The answer is a fresh stats frame,
          // and `saved: false` says the value was refused (a 0 or a non-number would be worse than
          // the old one).
          case "runtime.settings": {
            if (!(await requireStepUp())) return;
            const saved = writeLifecycle({ idleMs: msg.idleMs, watermarkBytes: msg.watermarkBytes });
            send({ type: "runtime.stats", ...(await sessions.runtimeStats()), saved: saved !== null });
            return;
          }
          // D120 / #80: the manual way out when memory is needed now. Only idle sessions sleep; a run
          // in flight is named in the receipt instead of being interrupted. It ends processes, so it
          // sits on the same step-up shelf as every other write: a public page must not be able to do
          // this with nothing but a socket message.
          case "runtime.sleepAll": {
            if (!(await requireStepUp())) return;
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
            send(frameFor(ws, { ...sessionFrameOf(session.pagedSnapshot()), trust: await trustFor(session.state.cwd) }));
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
            if (isWriteOp(op) && op.startsWith("pkg.")) refreshCatalog(true);
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
            // #288：新报文 `{ chrome: { id: boolean|null } }`（null = 删键）；旧的 `{ showExtButton }`
            // 继续接受，映射进 chrome.ext。白名单过滤在 writeUiPrefs 里。
            const prefs = writeUiPrefs({
              chrome: msg.chrome && typeof msg.chrome === "object" && !Array.isArray(msg.chrome) ? (msg.chrome as Record<string, unknown>) : undefined,
              showExtButton: typeof msg.showExtButton === "boolean" ? msg.showExtButton : undefined,
            });
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
          // D248：局域网共享市场。列清单 / 列本机可发布来源只读；发布 / 安装 / 删除 / 卸载全部拒公网。
          case "market.list": {
            const cwd = msg.cwd ? String(msg.cwd) : null;
            const reqId = typeof msg.reqId === "string" ? msg.reqId.slice(0, 60) : null;
            try {
              send({ type: "market.list", reqId, ...(await marketList(peer, cwd)) });
            } catch (err: any) {
              send({ type: "market.list", reqId, items: [], peers: [], error: String(err?.message ?? err) });
            }
            return;
          }
          case "market.sources": {
            const cwd = msg.cwd ? String(msg.cwd) : null;
            const reqId = typeof msg.reqId === "string" ? msg.reqId.slice(0, 60) : null;
            try {
              send({ type: "market.sources", reqId, ...(marketSources(cwd)) });
            } catch (err: any) {
              send({ type: "market.sources", reqId, skills: [], extensions: [], mcp: [], error: String(err?.message ?? err) });
            }
            return;
          }
          case "market.publish":
          case "market.delete":
          case "market.install":
          case "market.uninstall": {
            const op = String(msg.type ?? "");
            const reqId = typeof msg.reqId === "string" ? msg.reqId.slice(0, 60) : null;
            const cwd = msg.cwd ? String(msg.cwd) : null;
            const done = (out: { ok: boolean; error?: string; [k: string]: unknown }) => {
              send({ type: "market.op", reqId, op, ...out });
              if (out.ok) broadcast({ type: "market.changed" });
              else send({ type: "notice", text: String(out.error ?? "市场操作失败"), level: "error" });
            };
            if ((ws as any).publicReq) {
              done({ ok: false, error: "通过公网访问时局域网市场只能查看" });
              return;
            }
            if (!(await requireStepUp())) {
              done({ ok: false, error: "要重新输入口令才能改局域网市场" });
              return;
            }
            try {
              const publisher = String(msg.publisher ?? "");
              const id = String(msg.id ?? "");
              const scope = msg.scope === "project" ? "project" : "global";
              if (op === "market.publish") done(await marketPublish(peer, (msg.input ?? {}) as PublishInput));
              else if (op === "market.delete") done(await marketDelete(peer, cwd, publisher, id));
              else if (op === "market.uninstall") done(await marketUninstall(cwd, publisher, id));
              else {
                const vars = msg.vars && typeof msg.vars === "object" && !Array.isArray(msg.vars)
                  ? Object.fromEntries(Object.entries(msg.vars as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
                  : {};
                send({ type: "market.progress", reqId, text: "正在读取在线节点的清单…" });
                done(await marketInstall(peer, pi, cwd, publisher, id, scope, vars, (text) => send({ type: "market.progress", reqId, text })));
              }
            } catch (err: any) {
              done({ ok: false, error: String(err?.message ?? err) });
            }
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
          // ------------------------------------------------ AI 出错记录（D164）
          // 账本按工作区走，条目只读：只认「已修复 / 忽略 / 删除」，正文由「总结本轮错误」写入。
          case "failures.get": {
            const ws = String(msg.ws ?? "");
            send({ type: "failures", ws, ledger: readLedger(ws) });
            return;
          }
          case "failures.commit": {
            try {
              const items = (Array.isArray(msg.entries) ? (msg.entries as CommitItem[]) : [])
                .filter((e) => Boolean(e) && typeof e === "object" && typeof e.key === "string")
                .slice(0, 500)
                .map((e) => ({
                  key: String(e.key),
                  at: String(e.at ?? msg.at ?? ""),
                  tool: String(e.tool ?? ""),
                  code: String(e.code ?? ""),
                  sig: String(e.sig ?? ""),
                  exit: typeof e.exit === "number" ? e.exit : null,
                  cmd: String(e.cmd ?? ""),
                  out: String(e.out ?? ""),
                  why: String(e.why ?? ""),
                  fix: String(e.fix ?? ""),
                }));
              if (!items.length) {
                send({ type: "failures.saved", ws: String(msg.ws ?? ""), added: 0, empty: true });
                return;
              }
              const out = mergeFailures({
                ws: String(msg.ws ?? ""),
                label: typeof msg.label === "string" ? msg.label : undefined,
                sid: String(msg.sid ?? ""),
                sname: String(msg.sname ?? ""),
                at: String(msg.at ?? new Date().toISOString()),
                items,
              });
              log(`failures +${out.added} (${out.ledger.entries.length} 类) in ${out.ledger.ws}`);
              broadcast({ type: "failures", ws: out.ledger.ws, ledger: out.ledger });
              send({ type: "failures.saved", ws: out.ledger.ws, ledger: out.ledger, token: out.token, added: out.added });
            } catch (err: any) {
              send({ type: "failures.saved", error: String(err?.message ?? err) });
            }
            return;
          }
          case "failures.act": {
            try {
              const ledger = actOnFailure(String(msg.ws ?? ""), String(msg.key ?? ""), String(msg.action ?? "") as FailAction);
              broadcast({ type: "failures", ws: ledger.ws, ledger });
              send({ type: "failures.saved", ws: ledger.ws, ledger });
            } catch (err: any) {
              send({ type: "failures.saved", error: String(err?.message ?? err) });
            }
            return;
          }
          case "failures.undo": {
            try {
              const ledger = undoFailures(String(msg.token ?? ""));
              broadcast({ type: "failures", ws: ledger.ws, ledger });
              send({ type: "failures.saved", ws: ledger.ws, ledger, undone: true });
            } catch (err: any) {
              send({ type: "failures.saved", error: String(err?.message ?? err) });
            }
            return;
          }
          // D164 延伸：同一轮里第二次撞上同一类失败时叫住模型。前端判「这一会话里第几次」，
          // 桥这边再对一次账本（总数 ≥2 才算老毛病）与节流：不新开会话（没在跑就不提醒，
          // 否则为了一句提醒冷启一个 pi），同一类每个会话只提醒一次。
          case "failures.remind": {
            const sid = String(msg.sid ?? "");
            const key = String(msg.key ?? "");
            const ws = String(msg.ws ?? "");
            const text = reminderText({ tool: msg.tool, sig: msg.sig, why: msg.why, n: msg.n });
            const sess = sid ? sessions.get(sid) : undefined;
            // 回执（ok:false）让前端下一轮还能重试：桥丢了这条不等于「这一类此会话已提醒过」。
            if (process.env.PI_WEB_LESSONS === "0" || !sess || !sess.live || !text || !ws) return;
            let total = 0;
            try {
              total = readLedger(ws).entries.find((e) => e.key === key)?.count ?? 0;
            } catch {
              total = 0; // 读不到账本就不打断模型：这本来只是个提醒
            }
            if (total < 2 || !allowRemind(sid, key)) {
              send({ type: "failures.reminded", sessionId: sid, key, ok: false });
              return;
            }
            // 正在跑复盘那一轮：它谈的就是这些失败，再插一句「你刚又栽了」只会打断它。
            // 回 ok:false（不消费这次机会），下一轮还能再来。
            if (sess.reviewing) {
              send({ type: "failures.reminded", sessionId: sid, key, ok: false });
              return;
            }
            void sess.prompt(text, undefined, undefined, "followUp").then(
              () => send({ type: "failures.reminded", sessionId: sid, key, ok: true }),
              (err: any) => {
                log(`failures.remind failed: ${err?.message ?? err}`);
                send({ type: "failures.reminded", sessionId: sid, key, ok: false });
              },
            );
            log(`failures.remind → ${sid} (${key})`);
            return;
          }
          // ------------------------------------------------ 规矩（D164 延伸）
          // 复盘写下的「下次怎么做」，旁挂在账本边上：键与账本同一套，账本正文只读、规矩可改可删。
          case "rules.get": {
            const ws = String(msg.ws ?? "");
            send({ type: "rules", ws, book: readRules(ws) });
            return;
          }
          case "rules.set": {
            try {
              const book = setRule({
                ws: String(msg.ws ?? ""),
                key: String(msg.key ?? ""),
                rule: String(msg.rule ?? ""),
                tool: msg.tool == null ? undefined : String(msg.tool),
                code: msg.code == null ? undefined : String(msg.code),
                sig: msg.sig == null ? undefined : String(msg.sig),
              });
              log(`rules.set ${book.rules.length} 条 in ${book.ws}`);
              broadcast({ type: "rules", ws: book.ws, book });
              send({ type: "rules.saved", ws: book.ws, book });
            } catch (err: any) {
              send({ type: "rules.saved", error: String(err?.message ?? err) });
            }
            return;
          }
          case "rules.delete": {
            try {
              const book = deleteRule(String(msg.ws ?? ""), String(msg.key ?? ""));
              broadcast({ type: "rules", ws: book.ws, book });
              send({ type: "rules.saved", ws: book.ws, book });
            } catch (err: any) {
              send({ type: "rules.saved", error: String(err?.message ?? err) });
            }
            return;
          }
          // 复盘发出去了才记「这个会话已复盘 N 条」：发失败还留着让它重试，不能先占位。
          case "rules.reviewed": {
            try {
              const book = markReviewed(String(msg.ws ?? ""), String(msg.sid ?? ""), Number(msg.n) || 0);
              broadcast({ type: "rules", ws: book.ws, book });
            } catch (err: any) {
              log(`rules.reviewed failed: ${err?.message ?? err}`);
            }
            return;
          }
          // 「发到会话复盘」：把账本视角 + 提示词发进当前会话（人当场看得见，可打断）。
          // 规矩由模型按回写格式写在回答末尾，前端解析后 rules.set 落盘 —— 桥不解析模型的话。
          case "failures.review": {
            const sid = String(msg.sid ?? "");
            const ws = String(msg.ws ?? "");
            const classes = (Array.isArray(msg.classes) ? (msg.classes as any[]) : [])
              .filter((c) => Boolean(c) && typeof c === "object" && typeof c.key === "string")
              .slice(0, 50)
              .map((c) => ({
                key: String(c.key),
                tool: String(c.tool ?? ""),
                code: String(c.code ?? ""),
                sig: String(c.sig ?? ""),
                n: Math.max(1, Math.trunc(Number(c.n) || 1)),
              }));
            const failures = Math.max(1, Math.trunc(Number(msg.n) || 0));
            const sess = sid ? sessions.get(sid) : undefined;
            // 没在跑就不为一句复盘冷启 pi（和 remind 同一条理由）。
            if (!sess || !sess.live || !classes.length) {
              send({ type: "failures.reviewed", sessionId: sid, ok: false, reason: !sess || !sess.live ? "offline" : "empty" });
              return;
            }
            let ledger = emptyLedger(ws);
            try {
              ledger = readLedger(ws);
            } catch {
              // 账本读坏了也照发：复盘里少一段累计次数，比发不出去强。
            }
            let book = null;
            try {
              book = readRules(ws);
            } catch {
              book = null;
            }
            const text = reviewPrompt({ ledger, book, classes, failures });
            // 这一轮在谈失败本身，D169 再插一句「你刚又栽了」就是噪音。
            sess.reviewing = true;
            void sess.prompt(text, undefined, undefined, "followUp").then(
              () => send({ type: "failures.reviewed", sessionId: sid, ok: true, n: failures, classes: classes.length }),
              (err: any) => {
                sess.reviewing = false;
                log(`failures.review failed: ${err?.message ?? err}`);
                send({ type: "failures.reviewed", sessionId: sid, ok: false, reason: String(err?.message ?? err) });
              },
            );
            log(`failures.review → ${sid} (${classes.length} 类 / ${failures} 次)`);
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
                  refreshCatalog(true);
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
            refreshCatalog(true);
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
              broadcast({ type: "manage", ...manageSnapshot() });
              return;
            }
            if (action === "archive") {
              const on = msg.on !== false;
              sessions.setArchived(Array.isArray(msg.ids) ? msg.ids.map(String) : [], on);
              broadcast({ type: "manage", ...manageSnapshot() });
              return;
            }
            if (action === "opened") {
              // D146 废止了 D125：打开会话不改排列，所以这里什么也不写。仍然回一份快照，是因为
              // 旧页面（缓存里的 bundle）还会先乐观置顶再发这一条 —— 快照把它的 manage 纠正回来。
              broadcast({ type: "manage", ...manageSnapshot() });
              return;
            }
            if (action === "trash" || action === "delete") {
              const report = await sessions.trash(Array.isArray(msg.ids) ? msg.ids.map(String) : []);
              if (report.removed.length) broadcast({ type: "session.gone", ids: report.removed });
              broadcast({ type: "manage", ...manageSnapshot() });
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
              if (report.restored.length) broadcast({ type: "manage", ...manageSnapshot() });
              broadcast({ type: "trash", items: sessions.trashList() });
              if (report.restored.length) broadcast({ type: "sessions.list", sessions: sessions.list(), workspace: sessions.workspaces.snapshot() });
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
            // 工作区（一级分组 = 工程，#94 / D141）：动作都在 workspaces.ts 里，这里只做协议。
            if (action === "ws.list") {
              // 只回缓存里的快照（快）；缓存里没有的 cwd 顺手补上，补齐后会再来一条广播。
              send({ type: "workspaces", workspace: sessions.workspaces.snapshot() });
              void syncWorkspaces();
              return;
            }
            if (action === "ws.rename") {
              sessions.workspaces.rename(String(msg.id ?? ""), String(msg.name ?? ""));
              broadcast({ type: "workspaces", workspace: sessions.workspaces.snapshot() });
              return;
            }
            if (action === "ws.resolve") {
              // #278：只读解析「这个目录折回到哪个组」—— 子目录 / worktree 用；不建组、不广播。
              const dir = typeof msg.dir === "string" ? msg.dir : "";
              const group = dir ? await sessions.workspaces.resolveDir(dir) : null;
              send({ type: "ws.resolved", dir, id: group?.id ?? null });
              return;
            }
            if (action === "ws.create") {
              // #278：带 dir = 按目录建组（目录即组身份，已在列表里就只回 id，不再建第二个）；
              // 不带 dir = 老规矩，建一个空壳手动组、由页面接着进入改名。
              const dir = typeof msg.dir === "string" ? msg.dir : "";
              if (dir) {
                const result = await sessions.workspaces.createDir(dir);
                if (!result.ok || !result.group) {
                  send({ type: "notice", text: result.reason ?? "这个目录没能建成工作区", level: "warn" });
                  return;
                }
                broadcast({ type: "workspaces", workspace: sessions.workspaces.snapshot() });
                // 先广播快照、再回执：页面收到回执时树里已经有这一组了（也可能本来就有）。
                send({ type: "ws.created", id: result.group.id, created: result.created === true });
                return;
              }
              sessions.workspaces.create(String(msg.name ?? ""));
              broadcast({ type: "workspaces", workspace: sessions.workspaces.snapshot() });
              return;
            }
            if (action === "ws.move") {
              // wsId 为空 = 放回工程：删掉 override，让它重新跟着 cwd 走。
              const ids = Array.isArray(msg.ids) ? msg.ids.map(String) : [];
              const wsId = String(msg.wsId ?? "");
              if (wsId && !sessions.workspaces.group(wsId)) {
                send({ type: "notice", text: "这个工作区不在了", level: "warn" });
                return;
              }
              sessions.workspaces.move(ids, wsId);
              broadcast({ type: "workspaces", workspace: sessions.workspaces.snapshot() });
              // 会话的 ws 字段跟着变了，一起广播，免得卡片停在旧组里。
              broadcast({ type: "sessions.list", sessions: sessions.list(), workspace: sessions.workspaces.snapshot() });
              return;
            }
            if (action === "ws.row") {
              // #276：id 不存在或 inRow 不是布尔就静默忽略（旧页面 / 坏消息不该换来一条 warn）。
              if (typeof msg.id !== "string" || typeof msg.inRow !== "boolean") return;
              if (!sessions.workspaces.group(msg.id)) return;
              sessions.workspaces.setRow(msg.id, msg.inRow);
              broadcast({ type: "workspaces", workspace: sessions.workspaces.snapshot() });
              return;
            }
            if (action === "ws.delete") {
              const id = String(msg.id ?? "");
              const sessionIds = Array.isArray(msg.sessionIds) ? msg.sessionIds.map(String) : undefined;
              const result = await sessions.deleteWorkspace(id, sessionIds);
              const report = result.report;
              if (report?.removed.length) broadcast({ type: "session.gone", ids: report.removed });
              broadcast({ type: "manage", ...manageSnapshot() });
              broadcast({ type: "trash", items: sessions.trashList() });
              broadcast({ type: "workspaces", workspace: sessions.workspaces.snapshot() });
              broadcast({ type: "sessions.list", sessions: sessions.list(), workspace: sessions.workspaces.snapshot() });
              send({ type: "ws.delete.result", id, deleted: result.deleted, reasonCode: result.reasonCode, ...(report ?? {}) });
              return;
            }
            if (action === "ws.drop") {
              // Legacy clients may only remove empty groups; populated-workspace deletion requires confirmation.
              const id = String(msg.id ?? "");
              const result = sessions.dropWorkspace(id);
              if (!result.ok) {
                send({ type: "notice", text: result.reason ?? "这个工作区不能删", level: "warn" });
                return;
              }
              broadcast({ type: "workspaces", workspace: sessions.workspaces.snapshot() });
              // 删组会顺手清掉还指着它的 override，会话的 `ws` 跟着挪窝 —— 一起广播，别让卡片停在死组里。
              broadcast({ type: "sessions.list", sessions: sessions.list(), workspace: sessions.workspaces.snapshot() });
              return;
            }
            if (action === "ws.tabs") {
              // #173：`order` 是全量组序（含折叠组），与 `max` 各自可缺省；缺省的那个一个字都不动。
              const result = sessions.workspaces.setTabs({ order: msg.order, max: msg.max });
              if (!result.ok) {
                send({ type: "notice", text: result.reason ?? "标签行顺序没保存", level: "warn" });
                return;
              }
              broadcast({ type: "workspaces", workspace: sessions.workspaces.snapshot() });
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
        const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
        const message = String(err?.message ?? err);
        if (sessionId && message === "找不到这个会话") {
          send({ type: "error", sessionId, code: "session_not_found", message });
          return;
        }
        send({ type: "notice", text: message, level: "error" });
      }
    });
  });

  sessions.startGc((id) => [...wss.clients].some((client) => (client as any).watching === id));

  process.on("exit", () => {
    peer.stop();
    removePidFile(cfg.port);
  });

  server.listen(cfg.port, cfg.host, () => {
    // pid 文件：更新器靠它找到并重启「这一个」进程（见 pidfile.ts 的注释）。
    writePidFile(cfg.port);
    log(`listening on http://${cfg.host}:${cfg.port}`);
    // D209：启动时探一次引擎，排错时第一眼看日志就知道「这台机器能不能站内翻页」。
    const slidesProbed = slidesProbe();
    log(
      `slides: ${slidesProbed.available ? "PowerPoint" : "no PowerPoint"}` +
        `${slidesProbed.exe ? ` (${slidesProbed.exe})` : ""}`,
    );
    console.log(`\n  pi-web-client 已启动：http://127.0.0.1:${cfg.port}`);
    if (fresh) console.log(`  口令（首次生成，只显示这一次）：${fresh}\n`);
    else console.log(`  口令在 ${statePath("passphrase.txt")}\n`);
    if (cfg.tunnelAuto && tunnelBin) tunnel.start();
    // D161: pin 「the default permission as of now」 onto sessions the bridge has never looked at.
    // Async and best-effort: a session list that is a second late costs nothing, a crash on boot costs all.
    void sessions.pinAll().then((n) => n && log(`pinned default permission on ${n} session(s)`)).catch(() => {});
  });

  const shutdown = async () => {
    log("shutting down");
    terminals.closeAll();
    tunnel.stop();
    await sessions.shutdown();
    // Closing the bridge is closing 随手问: a clean exit leaves nothing to resume.
    resetScratchDir();
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
