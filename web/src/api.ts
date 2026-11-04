import type { GitInfo, Me, PreviewInfo, SessionState, SheetDoc, SheetEdit, SheetWindow, TunnelState } from "./types.ts";

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
  /** Bytes of an image on the bridge machine, as a File the composer can attach. */
  image: async (path: string): Promise<File> => {
    const res = await fetch(`/api/image?path=${encodeURIComponent(path)}`, { credentials: "same-origin" });
    if (!res.ok) throw await failOf(res, await res.text().catch(() => ""));
    const blob = await res.blob();
    return new File([blob], path.split(/[\\/]/).pop() ?? "image", { type: blob.type });
  },
  preview: (sessionId: string, path: string) =>
    req<PreviewInfo>("/api/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, path }) }),
  /** Write an edited text file back. 409 means the file changed on disk while it was open. */
  save: (sessionId: string, body: { path: string; text: string; mtime: number; size: number; copy?: boolean }) =>
    req<{ path: string; mtime: number; size: number }>("/api/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, ...body }),
    }),
  /** 表格（D116）：打开拿 token，之后按窗口要格子。 */
  sheetOpen: (sessionId: string, path: string) =>
    req<SheetDoc>("/api/sheet/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, path }) }),
  sheetWindow: (token: string, sheet: string, r0: number, r1: number, c0: number, c1: number) =>
    req<SheetWindow>("/api/sheet/window", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, sheet, r0, r1, c0, c1 }),
    }),
  sheetFind: (token: string, sheet: string, q: string, row: number, col: number) =>
    req<{ hits: { r: number; c: number }[]; more: boolean }>("/api/sheet/find", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, sheet, q, row, col }),
    }),
  /** 写回：`copy: true` 另存成 xxx.copy.xlsx，不覆盖原件。409 = 文件在这期间被别人改过。 */
  sheetSave: (token: string, groups: { sheet: string; edits: SheetEdit[] }[], mtime: number, size: number, copy: boolean) =>
    req<{ path: string; mtime: number; size: number; mode?: string }>("/api/sheet/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, groups, mtime, size, copy }),
    }),
  sheetStat: (token: string) => req<{ mtime: number; size: number }>("/api/sheet/stat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }),
  /** D69: open the folder holding this file in the desktop's own file manager (local / LAN only). */
  reveal: (path: string) =>
    req<{ ok: boolean; message: string }>("/api/reveal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) }),
  tunnel: (action: "start" | "stop") =>
    req<{ tunnel: TunnelState }>("/api/tunnel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) }),
  notifyTest: () => req<{ push: number; wechat: string }>("/api/notify-test", { method: "POST" }),
  subscribe: (sub: PushSubscriptionJSON) =>
    req<{ ok: true }>("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) }),
};
