import type { ArtifactDiff, ArtifactList, GitDiff, GitExecResult, GitHistory, GitInfo, GitOpParams, GitRefs, GitWorktreeState, Me, PreviewInfo, SessionState, SheetMatches, SheetMeta, SheetWindow, TunnelState } from "./types.ts";
import type { JiraDownloadPlan, JiraDownloadResult, JiraIssue, JiraIssueDetail, JiraProject, JiraSearchMeta, JiraUserOption } from "./jira-shared.ts";
import type { DnsResult, SysNetwork, WinnatResult, SysOverview, SysPorts, SysServices } from "./sysmanage-types.ts";

/**
 * D110: bridge 的错误响应是 `{ error, code?, params? }`。`error` 是中文兜底，`code` 才是给界面
 * 翻译用的键（`errText()` 拿 `code` + `params` 查词典）。两个字段都挂到 Error 上，认不出 `code`
 * 的地方仍然能用 `err?.message` 显示兜底句。
 */
async function failOf(res: Response, text: string): Promise<Error & { code?: string; params?: Record<string, string | number> }> {
  let message = text;
  let code: string | undefined;
  let params: Record<string, string | number> | undefined;
  try {
    const body = JSON.parse(text);
    message = body.error ?? text;
    code = body.code;
    params = body.params;
  } catch {
    /* keep raw text */
  }
  return Object.assign(new Error(message || `HTTP ${res.status}`), { status: res.status, code, params });
}

/** Small helper for the JSON POST routes; keeps the body shape in one place. */
function postJson<T>(path: string, body: unknown): Promise<T> {
  return req<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (!res.ok) {
    const error = await failOf(res, await res.text().catch(() => ""));
    if (error.code === "session_not_found" && typeof window !== "undefined") {
      let sessionId = "";
      try {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
      } catch {
        // Requests without a JSON body can carry the session id in their query string.
      }
      if (!sessionId) sessionId = new URL(path, window.location.href).searchParams.get("id") ?? "";
      window.dispatchEvent(new CustomEvent("pi-session-not-found", { detail: { sessionId } }));
    }
    throw error;
  }
  return (await res.json()) as T;
}

  /** `/api/stat` 的回答：文件夹、文件、不存在，或者不给看（权限）。 */
export type PathInfo = { path: string; kind: "dir" | "file" | "missing" | "denied"; parent: string | null };

/** 缺了少哪块功能的 id：和 `bridge/src/deps.ts` 的 `PackageId` 同一组值（前端不 import 桥的源码，所以抄一份）。 */
export type DepPackageId = "subagents" | "questionnaire" | "todo" | "web-access";

/** 一个“本项目需要”的 pi 包：来源、钉住的版本、缺了少哪块功能、现在装没装。 */
export interface DepPackageStatus {
  source: string;
  name: string;
  /** 钉死的版本；null = 跟 latest。 */
  version: string | null;
  /** 缺了少哪块功能：id，文案在 app.ts 的 depsFeature() 里用 tr() 写。 */
  id: DepPackageId;
  installed: boolean;
  foundVersion: string | null;
  /** 装了但比钉的旧：只提示，不自动升（已装就不动）。 */
  behind: boolean;
}

/** `scripts/bootstrap.mjs` 跑完留在状态目录里的结果。 */
export interface DepsBootstrap {
  at: number;
  ok: boolean;
  error: string | null;
  installed: string[];
  skipped: string[];
  pi: string | null;
}

/** `/api/deps`：pi 够不够新 + 三个扩展在不在（只读，只问本地 `pi list`）。 */
export interface DepsReport {
  pi: { version: string; min: string; ok: boolean };
  packages: DepPackageStatus[];
  /** 可选包（例如 billion-context）：没装不拦人，界面自己决定要不要灰掉。 */
  optional: { name: string; id: string; installed: boolean }[];
  missing: number;
  ready: boolean;
  bootstrap: DepsBootstrap | null;
  command: string;
}

export const api = {
  me: () => req<Me>("/api/me"),
  /** 本项目需要什么（pi 版本 + 三个扩展）。只读；装是 `npm install` 的 postinstall 干的。 */
  deps: () => req<DepsReport>("/api/deps"),
  login: (passphrase: string) =>
    req<{ ok: true }>("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase }) }),
  logout: () => req<{ ok: true }>("/api/logout", { method: "POST" }),
  sessions: () => req<{ sessions: SessionState[]; tunnel: TunnelState }>("/api/sessions"),
  dirs: (path: string, files = false) =>
    req<{
      path: string;
      parent: string | null;
      dirs: string[];
      files?: string[];
      /** D62: used/total per drive root, only when listing the roots (empty path). */
      volumes?: { root: string; total: number; free: number }[];
      error?: string;
    }>(`/api/dirs?path=${encodeURIComponent(path)}${files ? "&files=1" : ""}`),
  /** D62: sizes/mtimes for one directory, asked for separately so the file rows can paint first. */
  fileStats: (path: string) =>
    req<{ files: { name: string; size: number; mtime: number }[] }>(`/api/dirs?path=${encodeURIComponent(path)}&stats=1`),
  /**
   * 输入路径跳转：先问这条路径是文件夹、文件还是没有。/api/dirs 对文件答 ENOTDIR，读起来像坏了的
   * 文件夹，所以「进入 / 高亮父目录那一行 / 报错」这三条路要在请求列表之前先分清楚。
   */
  statPath: (path: string) => req<PathInfo>(`/api/stat?path=${encodeURIComponent(path)}`),
  clipboardFiles: () => req<{ paths: string[] }>("/api/clipboard-files"),
  /**
   * Q-021: branch of the repo containing `dir`, or null when it is not in one.
   * D240: 公网 / 局域网访客登录后也能读，不再按来源回 null。`fresh` skips the bridge's 5s cache.
   */
  git: async (dir: string, fresh = false): Promise<GitInfo | null> => {
    if (!dir) return null;
    const out = await req<{ repo: string | null; branch?: string; detached?: boolean; empty?: boolean; dirty?: number }>(
      `/api/git?dir=${encodeURIComponent(dir)}${fresh ? "&fresh=1" : ""}`,
    );
    if (!out.repo) return null;
    return { repo: out.repo, branch: out.branch ?? "", detached: out.detached === true, empty: out.empty === true, dirty: out.dirty ?? 0 };
  },
  /**
   * D235: 分支操作工作台「历史」tab 的两列。桥回 `{repo:null, code}` 时抛错
   * （`empty` / `base_unknown` / 读不到），界面用 `errText()` 翻成人话。`fresh` 在 fetch 或写操作之后用一次。
   */
  gitHistory: async (dir: string, base = "", n = 80, fresh = false): Promise<GitHistory> => {
    const out = await req<GitHistory & { repo: string | null; code?: string; error?: string }>(
      `/api/git/history?dir=${encodeURIComponent(dir)}${base ? `&base=${encodeURIComponent(base)}` : ""}&n=${n}${fresh ? "&fresh=1" : ""}`,
    );
    if (!out.repo) throw Object.assign(new Error(out.error ?? "读不了分支历史"), { code: out.code });
    return out;
  },
  /** D235: 工作台里那个手动 fetch。失败也回 200 + `{ok:false, code, error}`，这里统一抛。 */
  gitFetch: async (dir: string): Promise<{ at: number; remote: string }> => {
    const out = await req<{ ok: boolean; at?: number; remote?: string; code?: string; error?: string }>("/api/git/fetch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir }),
    });
    if (!out.ok) throw Object.assign(new Error(out.error ?? "git fetch 失败"), { code: out.code });
    return { at: out.at ?? Date.now(), remote: out.remote ?? "origin" };
  },
  /**
   * #392 目录与仓库：展开一层时批量问「这些直接子目录里哪些自己是仓库」。
   * 值只可能是子目录自己的仓库（父仓库里的普通目录回 null）。D240: 公网 / 局域网同样可问。
   */
  gitProbe: async (dir: string, names: string[], fresh = false): Promise<{ probes: Record<string, GitInfo | null>; truncated: boolean }> => {
    const out = await postJson<{ probes?: Record<string, GitInfo | null>; truncated?: boolean }>("/api/git/probe", { dir, names, fresh });
    const probes: Record<string, GitInfo | null> = {};
    for (const name of names) {
      const info = out.probes?.[name];
      probes[name] = info && info.repo ? info : null;
    }
    return { probes, truncated: out.truncated === true };
  },
  /** D235: 工作台的仓库状态（逐文件暂存/改动/冲突）。 */
  gitState: (dir: string) => postJson<GitWorktreeState>("/api/git/state", { dir }),
  /** D235: 本地 + 远程分组的分支列表，给切换、合并和对照检索用。 */
  gitRefs: (dir: string) => postJson<GitRefs>("/api/git/refs", { dir }),
  /** D235: 当前分支 vs 对照 / 单条提交 vs 父提交的并排富视图。 */
  gitDiff: (dir: string, base = "", target = "HEAD", commit = "") =>
    postJson<GitDiff>("/api/git/diff", { dir, base, target, commit }),
  /**
   * D235: 只发 id + 结构化 params，真正的 argv 由桥端白名单拼。
   * git 自己失败时也回 200 + 完整结果（退出码/stderr/state），界面据此画失败卡；
   * 只有 HTTP 层的错误才由 req() 抛出。
   */
  gitOp: (dir: string, id: string, params: GitOpParams = {}) =>
    postJson<GitExecResult>("/api/git/op", { dir, id, params }),
  /** Bytes of an image on the bridge machine, as a File the composer can attach. */
  image: async (path: string): Promise<File> => {
    const res = await fetch(`/api/image?path=${encodeURIComponent(path)}`, { credentials: "same-origin" });
    if (!res.ok) throw await failOf(res, await res.text().catch(() => ""));
    const blob = await res.blob();
    return new File([blob], path.split(/[\\/]/).pop() ?? "image", { type: blob.type });
  },
  preview: (sessionId: string, path: string) =>
    req<PreviewInfo>("/api/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, path }) }),
  /**
   * D208: 产物弹窗的两条数据。
   * 列表由页面把重放历史时收到的 write/edit 递过去（路径 + 工具 + 次数），桥负责解析/查基线/算行数；
   * 差异按路径单独取，切文件时只多拉这一份。
   */
  artifactsList: (sessionId: string, items: { path: string; tool: string; writes: number }[]) =>
    req<ArtifactList>("/api/artifacts/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, items }),
    }),
  artifactDiff: (sessionId: string, path: string) =>
    req<ArtifactDiff>("/api/artifacts/diff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, path }),
    }),
  /** D166: sheet metadata and one visible row window, both keyed by the /api/preview grant token. */
  sheetMeta: (token: string) =>
    req<SheetMeta>("/api/sheet/meta", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }),
  /** #112: ask the bridge to lay out the page view (or report it already done); returns a ready|pending|failed id. */
  sheetPdf: (token: string, retry = false) =>
    req<{ id: string; status: "ready" | "pending" | "failed"; error?: string; code?: string }>("/api/sheet/pdf", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, retry }) }),
  /** #112: the byte endpoint the iframe points at once the page view is ready. */
  sheetPdfUrl: (id: string, token: string) => `/api/sheet/pdf?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`,
  /** D209: same two-stage contract as the page view, but PowerPoint lays the deck out. */
  slidesPdf: (token: string, retry = false) =>
    req<{ id: string; status: "ready" | "pending" | "failed"; error?: string; code?: string }>("/api/slides/pdf", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, retry }),
    }),
  slidesPdfUrl: (id: string, token: string) =>
    `/api/slides/pdf?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`,
  sheetWindow: (token: string, sheet: string, r0: number, r1: number, c0: number, c1: number) =>
    req<SheetWindow>("/api/sheet/window", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, sheet, r0, r1, c0, c1 }),
    }),
  /** #107: whole-sheet search, server side — the page only ever holds one visible window. */
  sheetFind: (token: string, sheet: string, q: string) =>
    req<SheetMatches>("/api/sheet/find", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, sheet, q }),
    }),
  /** D166/#106 出口: hand the previewed workbook to this desktop's own program (Excel). */
  openFile: (token: string) =>
    req<{ ok: boolean; message: string }>("/api/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }),
  /** Write an edited text file back. 409 means the file changed on disk while it was open. */
  save: (sessionId: string, body: { path: string; text: string; mtime: number; size: number; copy?: boolean }) =>
    req<{ path: string; mtime: number; size: number }>("/api/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, ...body }),
    }),
  /** D69: open the folder holding this file in the desktop's own file manager (local / LAN only). */
  reveal: (path: string) =>
    req<{ ok: boolean; message: string }>("/api/reveal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) }),
  tunnel: (action: "start" | "stop") =>
    req<{ tunnel: TunnelState }>("/api/tunnel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) }),
  /** #248：Jira 面板。token 只在桥那边，这里拿到的是掩码；保存失败会抛带 `code` 的错。 */
  jiraConfig: () =>
    req<{ configured: boolean; siteUrl: string; email: string; keyMask: string; readonly: boolean }>(
      "/api/jira/config",
    ),
  jiraSave: (body: { siteUrl: string; email: string; apiKey: string }) =>
    req<{ ok: true; me: { accountId: string; displayName: string; email: string; timezone: string; avatarUrl: string } }>(
      "/api/jira/config",
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    ),
  jiraClear: () => req<{ ok: true }>("/api/jira/config", { method: "DELETE" }),
  jiraMe: () =>
    req<{ accountId: string; displayName: string; email: string; timezone: string; avatarUrl: string }>("/api/jira/me"),
  /** #249：桥固定查「分配给我 + 未解决」；refresh 绕过桥的 60 秒缓存（D203）。 */
  jiraIssues: (refresh = false) => req<{ issues: JiraIssue[] }>(`/api/jira/issues${refresh ? "?refresh=1" : ""}`),
  jiraProjects: (refresh = false) => req<{ projects: JiraProject[] }>(`/api/jira/projects${refresh ? "?refresh=1" : ""}`),
  /** #257：结构化条件由页面拼 query，桥端负责校验、拼 JQL 与关注者降级。#407：工单号模糊时回 `fuzzy`（D243）。 */
  jiraSearch: (params: string) =>
    req<{
      issues: JiraIssue[];
      nextPageToken?: string;
      isLast: boolean;
      degraded?: { watchers: boolean };
      fuzzy?: { token: string; fallback?: boolean };
    }>(`/api/jira/search${params ? `?${params}` : ""}`),
  /** #257：类型 / 优先级 / 项目内状态。`project` 为空时 `statuses` 也是空的。 */
  jiraSearchMeta: (project?: string) =>
    req<JiraSearchMeta>(
      `/api/jira/meta${project ? `?project=${encodeURIComponent(project)}` : ""}`,
    ),
  /** #257：人员选择器的候选。桥端 403 时回 `{users: [], unavailable: true}`。 */
  jiraUsers: (q: string) =>
    req<{ users: JiraUserOption[]; unavailable?: boolean }>(`/api/jira/users?q=${encodeURIComponent(q)}`),
  /** #250：单工单详情。key 只做形状校验（桥端权威）；description 是 ADF，由页面转文本（D204）。 */
  jiraIssue: (key: string) =>
    req<JiraIssueDetail>(`/api/jira/issues/${encodeURIComponent(key)}`),
  /** #251：附件根目录。隧道访客只能读；写入由桥回 403 `tunnel_readonly`。 */
  jiraAttachRoot: () => req<{ root: string | null }>("/api/jira/attachments/root"),
  jiraSetAttachRoot: (root: string) =>
    req<{ ok: true; root: string }>("/api/jira/attachments/root", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root }),
    }),
  /** #251 / #407：把这单的附件收下来。`conflict` = 撞到同名文件时怎么办：不带 → 409 带清单（先问），`skip` 跳过已存在的、其余照下，`overwrite` 全部重写。 */
  jiraDownload: (key: string, conflict?: "skip" | "overwrite") =>
    req<JiraDownloadResult>(
      `/api/jira/issues/${encodeURIComponent(key)}/download${conflict ? `?conflict=${conflict}` : ""}`,
      { method: "POST" },
    ),
  /** #407：只算不写 —— 每个附件会落到哪、是不是已经在目录里；交接前判断「还缺几个」也用它。只读，隧道也允许。 */
  jiraDownloadPlan: (key: string) =>
    req<JiraDownloadPlan>(`/api/jira/issues/${encodeURIComponent(key)}/download`),
  /** #252/D209：这单在本机已经下过几个文件；没下过时 `{ dir: null, count: 0 }`。只读磁盘，隧道也允许。
   *  file 级的 `path` 是桥拼好的绝对路径（页面不该自己拼分隔符）。 */
  jiraDownloaded: (key: string) =>
    req<{
      dir: string | null;
      count: number;
      files?: { name: string; path: string; size: number; mtime: number }[];
    }>(`/api/jira/issues/${encodeURIComponent(key)}/downloaded`),
  /** #266：本机管理。读本机与局域网；公网拿到的已经由桥打码。 */
  sysOverview: () => req<SysOverview>("/api/sys?section=overview"),
  sysNetwork: () => req<SysNetwork>("/api/sys?section=network"),
  sysPorts: () => req<SysPorts>("/api/sys?section=ports"),
  sysServices: () => req<SysServices>("/api/sys?section=services"),
  /** 写只有 DNS；桥端本机/局域网预授权，公网 403。每次应用都会在主机桌面弹 UAC。 */
  sysDnsApply: (guid: string, servers: string[]) =>
    req<DnsResult>("/api/sys/dns", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guid, servers }) }),
  sysDnsRestore: (guid: string) =>
    req<DnsResult>("/api/sys/dns/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guid }) }),
  sysWinnatRestart: () => req<WinnatResult>("/api/sys/winnat/restart", { method: "POST" }),
  notifyTest: () => req<{ push: number; wechat: string }>("/api/notify-test", { method: "POST" }),
  subscribe: (sub: PushSubscriptionJSON) =>
    req<{ ok: true }>("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) }),
};
