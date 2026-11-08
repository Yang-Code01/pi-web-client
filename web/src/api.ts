import type { GitHistory, GitInfo, Me, PreviewInfo, SessionState, SheetMatches, SheetMeta, SheetWindow, TunnelState } from "./types.ts";

/**
 * D110: bridge 的错误响应是 `{ error, code?, params? }`。`error` 是中文兜底，`code` 才是给界面
 * 翻译用的键（`errText()` 拿 `code` + `params` 查词典）。两个字段都挂到 Error 上，认不出 `code`
 * 的地方仍然能用 `err?.message` 显示兜底句。
 */
async function failOf(res: Response, text: string): Promise<Error> {
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

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (!res.ok) throw await failOf(res, await res.text().catch(() => ""));
  return (await res.json()) as T;
}

  /** `/api/stat` 的回答：文件夹、文件、不存在，或者不给看（权限）。 */
export type PathInfo = { path: string; kind: "dir" | "file" | "missing" | "denied"; parent: string | null };

export const api = {
  me: () => req<Me>("/api/me"),
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
   * Q-021: branch of the repo containing `dir`, or null when it is not in one (or the bridge is
   * on the far side of a tunnel). `fresh` skips the bridge's 5s cache.
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
   * D193: 分支历史弹窗的两列。桥回 `{repo:null, code}` 时抛错（`empty` / `base_unknown` / 读不到），
   * 界面用 `errText()` 翻成人话。`fresh` 只在 fetch 之后用一次。
   */
  gitHistory: async (dir: string, base = "", n = 80, fresh = false): Promise<GitHistory> => {
    const out = await req<GitHistory & { repo: string | null; code?: string; error?: string }>(
      `/api/git/history?dir=${encodeURIComponent(dir)}${base ? `&base=${encodeURIComponent(base)}` : ""}&n=${n}${fresh ? "&fresh=1" : ""}`,
    );
    if (!out.repo) throw Object.assign(new Error(out.error ?? "读不了分支历史"), { code: out.code });
    return out;
  },
  /** D193: 弹窗里那个手动 fetch。失败也回 200 + `{ok:false, code, error}`，这里统一抛。 */
  gitFetch: async (dir: string): Promise<{ at: number; remote: string }> => {
    const out = await req<{ ok: boolean; at?: number; remote?: string; code?: string; error?: string }>("/api/git/fetch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir }),
    });
    if (!out.ok) throw Object.assign(new Error(out.error ?? "git fetch 失败"), { code: out.code });
    return { at: out.at ?? Date.now(), remote: out.remote ?? "origin" };
  },
  /** Bytes of an image on the bridge machine, as a File the composer can attach. */
  image: async (path: string): Promise<File> => {
    const res = await fetch(`/api/image?path=${encodeURIComponent(path)}`, { credentials: "same-origin" });
    if (!res.ok) throw await failOf(res, await res.text().catch(() => ""));
    const blob = await res.blob();
    return new File([blob], path.split(/[\\/]/).pop() ?? "image", { type: blob.type });
  },
  preview: (sessionId: string, path: string) =>
    req<PreviewInfo>("/api/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, path }) }),
  /** D166: sheet metadata and one visible row window, both keyed by the /api/preview grant token. */
  sheetMeta: (token: string) =>
    req<SheetMeta>("/api/sheet/meta", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }),
  /** #112: ask the bridge to lay out the page view (or report it already done); returns a ready|pending|failed id. */
  sheetPdf: (token: string, retry = false) =>
    req<{ id: string; status: "ready" | "pending" | "failed"; error?: string; code?: string }>("/api/sheet/pdf", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, retry }) }),
  /** #112: the byte endpoint the iframe points at once the page view is ready. */
  sheetPdfUrl: (id: string, token: string) => `/api/sheet/pdf?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`,
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
  notifyTest: () => req<{ push: number; wechat: string }>("/api/notify-test", { method: "POST" }),
  subscribe: (sub: PushSubscriptionJSON) =>
    req<{ ok: true }>("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) }),
};
