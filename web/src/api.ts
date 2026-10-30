import type { Me, SessionState, TunnelState } from "./types.ts";

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
  tunnel: (action: "start" | "stop") =>
    req<{ tunnel: TunnelState }>("/api/tunnel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) }),
  notifyTest: () => req<{ push: number; wechat: string }>("/api/notify-test", { method: "POST" }),
  subscribe: (sub: PushSubscriptionJSON) =>
    req<{ ok: true }>("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) }),
};
