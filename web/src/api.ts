import type { GitInfo, Me, PreviewInfo, SessionState, TunnelState } from "./types.ts";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      message = JSON.parse(text).error ?? text;
    } catch {
      /* keep raw text */
    }
    throw Object.assign(new Error(message || `HTTP ${res.status}`), { status: res.status });
  }
  return (await res.json()) as T;
}

export const api = {
  me: () => req<Me>("/api/me"),
  login: (passphrase: string) =>
    req<{ ok: true }>("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase }) }),
  logout: () => req<{ ok: true }>("/api/logout", { method: "POST" }),
  sessions: () => req<{ sessions: SessionState[]; tunnel: TunnelState }>("/api/sessions"),
  dirs: (path: string, files = false) =>
    req<{ path: string; parent: string | null; dirs: string[]; files?: string[]; error?: string }>(`/api/dirs?path=${encodeURIComponent(path)}${files ? "&files=1" : ""}`),
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
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = text;
      try {
        message = JSON.parse(text).error ?? text;
      } catch {
        /* keep raw text */
      }
      throw new Error(message || `HTTP ${res.status}`);
    }
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
  tunnel: (action: "start" | "stop") =>
    req<{ tunnel: TunnelState }>("/api/tunnel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) }),
  notifyTest: () => req<{ push: number; wechat: string }>("/api/notify-test", { method: "POST" }),
  subscribe: (sub: PushSubscriptionJSON) =>
    req<{ ok: true }>("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) }),
};
