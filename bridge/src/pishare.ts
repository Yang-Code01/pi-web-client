/**
 * `/share` and `/bug` for the web (#38), built from pi's own pieces in the bridge process.
 *
 * pi's implementations (modes/interactive/session-share.js, bug-report.js) drive TUI dialogs and a
 * live AgentSession. The parts that matter are exported by pi and used here unchanged:
 * `serializeSessionBranch` (the JSONL that is uploaded), `collectBugReportMetadata` /
 * `collectBugReportDiagnostics` (what a bug report contains — settings redacted, no API keys),
 * `uploadBugReport` / `writeBugReportArchive`, `getShareViewerUrl`, the radius gateway and the
 * credential lookup. The session is read from its file, never written to.
 *
 * Differences from the terminal, all because there is no live pi session object here:
 *  - the shared/attached transcript has no trailing `pi.share` entry (system prompt + tool schemas);
 *  - the bug report lists no loaded extensions, and offers no model-written summary;
 *  - nothing is appended to the session file to record that a report was made.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentDir, ensureDir, readJson, statePath } from "./paths.ts";
import { piModule } from "./pimods.ts";

/** `gh`, or (tests) a JS stand-in run with this node: PI_WEB_GH_JS. */
function gh(args: string[]): [string, string[]] {
  const js = process.env.PI_WEB_GH_JS;
  return js ? [process.execPath, [js, ...args]] : ["gh", args];
}

async function runtime(cli: string): Promise<any> {
  const { ModelRuntime } = await piModule(cli, "core/model-runtime.js");
  return ModelRuntime.create({ authPath: path.join(agentDir(), "auth.json"), modelsPath: path.join(agentDir(), "models.json"), allowModelNetwork: false });
}

async function openSession(cli: string, file: string): Promise<any> {
  const { SessionManager } = await piModule(cli, "core/session-manager.js");
  return SessionManager.open(file, path.dirname(file));
}

async function radiusToken(cli: string, rt: any): Promise<string | undefined> {
  if (!rt.getProvider("radius")) return undefined;
  const { getAuthCredential } = await piModule(cli, "cli/auth-command.js");
  try {
    return getAuthCredential(await rt.getAuth("radius", { minOAuthValidityMs: 5 * 60_000 })) ?? undefined;
  } catch {
    return undefined;
  }
}

function shareDestination(cwd: string): "auto" | "gist" | "radius" {
  const pick = (v: unknown) => (v === "gist" || v === "radius" || v === "auto" ? v : null);
  const project = pick(readJson<Record<string, unknown>>(path.join(cwd, ".pi", "settings.json"), {}).sessionShareDestination);
  const global = pick(readJson<Record<string, unknown>>(path.join(agentDir(), "settings.json"), {}).sessionShareDestination);
  return project ?? global ?? "auto";
}

export interface ShareResult {
  via: "radius" | "gist";
  url: string;
  gistUrl?: string;
}

/**
 * Same order as pi: Radius (when logged in and the destination allows it), else a private gist of
 * pi's HTML export through the GitHub CLI.
 */
export async function shareSession(cli: string, file: string, cwd: string, progress: (msg: string) => void): Promise<ShareResult> {
  const destination = shareDestination(cwd);
  const sm = await openSession(cli, file);
  if (destination !== "gist") {
    const rt = await runtime(cli);
    const token = await radiusToken(cli, rt);
    if (token) {
      progress("上传到 Radius…");
      const { serializeSessionBranch } = await piModule(cli, "core/session-export.js");
      const { getRadiusGatewayUrl } = await piModule(cli, "core/radius.js");
      const body = Buffer.from(serializeSessionBranch(sm));
      const url = new URL("/v1/artifacts", getRadiusGatewayUrl());
      url.searchParams.set("visibility", "organization");
      url.searchParams.set("title", "Pi session");
      const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-ndjson", "Content-Length": String(body.byteLength) }, body });
      const json = (await res.json().catch(() => null)) as { artifact?: { canonical_url?: string }; error?: string } | null;
      if (!res.ok || !json?.artifact?.canonical_url) throw new Error(`上传 Radius 失败：${json?.error || res.statusText || res.status}`);
      return { via: "radius", url: json.artifact.canonical_url };
    }
    if (destination === "radius") throw new Error("设置要求分享到 Radius，但还没登录 Radius：先在「登录 / 凭据」里登录 radius。");
  }
  // gist
  const [ghCmd, ghArgs] = gh(["auth", "status"]);
  const auth = spawnSync(ghCmd, ghArgs, { encoding: "utf8", windowsHide: true });
  if (auth.error) throw new Error("没装 GitHub CLI（gh），分享要用它建私有 gist：https://cli.github.com/");
  if (auth.status !== 0) throw new Error("GitHub CLI 没登录：在终端里运行 gh auth login。");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-share-"));
  try {
    progress("导出 HTML…");
    const html = path.join(tmp, "session.html");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "--export", file, html], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let err = "";
      child.stderr.on("data", (b) => (err += b));
      child.on("close", (code) => (code === 0 && fs.existsSync(html) ? resolve() : reject(new Error(`pi --export 失败：${err.trim() || code}`))));
    });
    progress("创建私有 gist…");
    const out = await new Promise<string>((resolve, reject) => {
      const [cmd, args] = gh(["gist", "create", "--public=false", html]);
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b) => (stdout += b));
      child.stderr.on("data", (b) => (stderr += b));
      child.on("close", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(`建 gist 失败：${stderr.trim() || code}`))));
    });
    const gistUrl = out.split(/\s+/).pop() ?? "";
    const gistId = gistUrl.split("/").pop();
    if (!gistId) throw new Error(`看不懂 gh 的输出：${out}`);
    const { getShareViewerUrl } = await piModule(cli, "config.js");
    return { via: "gist", url: getShareViewerUrl(gistId), gistUrl };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export interface BugOptions {
  hint?: string;
  includeSession: boolean;
  delivery: "upload" | "zip";
}

/** The model the session used last (provider + id from its newest assistant message). */
function lastModel(sm: any): { provider: string; id: string } | null {
  const entries = sm.getEntries() as any[];
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i]?.type === "message" ? entries[i].message : null;
    if (m?.role === "assistant" && m.provider && m.model) return { provider: String(m.provider), id: String(m.model) };
  }
  return null;
}

export async function reportBug(cli: string, file: string, cwd: string, opts: BugOptions): Promise<{ id: string; delivery: "upload" | "zip"; zip?: string }> {
  if (opts.delivery === "upload" && process.env.PI_OFFLINE) throw new Error("离线模式不能上传，改用「导出 zip」。");
  const sm = await openSession(cli, file);
  const rt = await runtime(cli);
  const bug = await piModule(cli, "core/bug-report.js");
  const { readCrashLog } = await piModule(cli, "core/crash-log.js");
  const { serializeSessionBranch } = await piModule(cli, "core/session-export.js");
  const used = lastModel(sm);
  const messageCount = (sm.getEntries() as any[]).filter((e) => e?.type === "message").length;
  const bundle = {
    metadata: bug.collectBugReportMetadata({
      hint: opts.hint,
      sessionId: sm.getSessionId(),
      cwd,
      includeSession: opts.includeSession,
      includeSummary: false,
      messageCount,
      model: used ? rt.getModel(used.provider, used.id) : undefined,
      modelRuntime: rt,
      thinkingLevel: undefined,
      extensions: [],
      extensionErrors: [],
      globalSettings: readJson<Record<string, unknown>>(path.join(agentDir(), "settings.json"), {}),
      projectSettings: readJson<Record<string, unknown>>(path.join(cwd, ".pi", "settings.json"), {}),
    }),
    diagnostics: bug.collectBugReportDiagnostics(sm, readCrashLog()),
    summary: undefined,
    sessionJsonl: opts.includeSession ? serializeSessionBranch(sm) : undefined,
  };
  const id = String(bundle.metadata.id);
  if (opts.delivery === "upload") {
    const { uploadBugReport } = await piModule(cli, "core/bug-report-upload.js");
    const result = await uploadBugReport(bundle, { token: await radiusToken(cli, rt) });
    return { id: String(result.id ?? id), delivery: "upload" };
  }
  const zip = statePath("bug-reports", bug.bugReportArchiveFileName(id));
  ensureDir(path.dirname(zip));
  await bug.writeBugReportArchive(bundle, zip);
  return { id, delivery: "zip", zip };
}
