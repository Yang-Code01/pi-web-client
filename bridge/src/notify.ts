import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import webpush from "web-push";
import { agentDir, ensureStateDirs, readJson, statePath, writeJson } from "./paths.ts";

interface WechatCreds {
  token?: string;
  baseUrl?: string;
  accountId?: string;
  userId?: string;
  savedAt?: string;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: number;
  label?: string;
}

function wechatStateDir(): string {
  return path.join(agentDir(), "wechat-assistant");
}

export class Notifier {
  private vapid: { publicKey: string; privateKey: string };
  private subs: PushSubscriptionRecord[] = [];

  constructor() {
    ensureStateDirs();
    this.vapid = this.loadVapid();
    webpush.setVapidDetails("mailto:pi-web-client@localhost", this.vapid.publicKey, this.vapid.privateKey);
    this.subs = readJson<PushSubscriptionRecord[]>(statePath("push-subs.json"), []);
  }

  private loadVapid(): { publicKey: string; privateKey: string } {
    const file = statePath("vapid.json");
    const existing = readJson<{ publicKey: string; privateKey: string } | null>(file, null);
    if (existing?.publicKey && existing?.privateKey) return existing;
    const keys = webpush.generateVAPIDKeys();
    writeJson(file, keys);
    return keys;
  }

  get vapidPublicKey(): string {
    return this.vapid.publicKey;
  }

  subscriptionCount(): number {
    return this.subs.length;
  }

  addSubscription(sub: PushSubscriptionRecord): void {
    this.subs = this.subs.filter((s) => s.endpoint !== sub.endpoint);
    this.subs.push(sub);
    writeJson(statePath("push-subs.json"), this.subs);
  }

  removeSubscription(endpoint: string): void {
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    writeJson(statePath("push-subs.json"), this.subs);
  }

  async push(title: string, body: string, url: string): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const sub of [...this.subs]) {
      try {
        await webpush.sendNotification(sub as any, JSON.stringify({ title, body, url }), { TTL: 600 });
        sent += 1;
      } catch (err: any) {
        failed += 1;
        if (err?.statusCode === 404 || err?.statusCode === 410) this.removeSubscription(sub.endpoint);
      }
    }
    return { sent, failed };
  }

  /** WeChat via the iLink bot API, reusing the pi-wechat-assistant login (D24). */
  async wechat(text: string): Promise<{ ok: boolean; reason?: string }> {
    let creds: WechatCreds;
    try {
      creds = JSON.parse(fs.readFileSync(path.join(wechatStateDir(), "credentials.json"), "utf8"));
    } catch {
      return { ok: false, reason: "没找到微信凭证（先在 pi 里登录 wechat 插件）" };
    }
    if (!creds.token || !creds.baseUrl) return { ok: false, reason: "微信凭证不完整" };

    let tokens: { lastUserId: string | null; tokens: Record<string, string> } = { lastUserId: null, tokens: {} };
    try {
      tokens = JSON.parse(fs.readFileSync(path.join(wechatStateDir(), "context-tokens.json"), "utf8"));
    } catch {
      /* no context tokens yet */
    }
    const userId = creds.userId || tokens.lastUserId;
    if (!userId) return { ok: false, reason: "不知道发给谁（还从没在微信里跟 bot 说过话）" };
    const contextToken = tokens.tokens?.[userId];

    const body = {
      msg: {
        from_user_id: "",
        to_user_id: userId,
        client_id: crypto.randomUUID(),
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: { channel_version: "1.0.0" },
    };

    try {
      const res = await fetch(new URL("/ilink/bot/sendmessage", `${creds.baseUrl.replace(/\/$/, "")}/`), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${creds.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const raw = await res.text();
      let parsed: any = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* non-JSON body */
      }
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      if (parsed && typeof parsed.errcode === "number" && parsed.errcode !== 0) {
        return { ok: false, reason: `登录过期（${parsed.errmsg ?? parsed.errcode}），在 pi 里重新登录微信插件` };
      }
      if (parsed && typeof parsed.ret === "number" && parsed.ret !== 0) {
        return {
          ok: false,
          reason: `微信拒绝了推送（ret=${parsed.ret} ${parsed.errmsg ?? ""}）—— 通常是因为很久没在微信里跟 bot 说话`,
        };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, reason: `发送失败：${err?.message ?? err}` };
    }
  }

  /** Both channels; Web Push first (fast), WeChat as the reliable one. */
  async notify(title: string, body: string, url: string): Promise<{ push: number; wechat: string }> {
    const push = await this.push(title, body, url).catch(() => ({ sent: 0, failed: 0 }));
    const wx = await this.wechat(`${title}\n${body}\n${url}`).catch((e) => ({ ok: false, reason: String(e) }));
    return { push: push.sent, wechat: wx.ok ? "ok" : wx.reason ?? "failed" };
  }
}
