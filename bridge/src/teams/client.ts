/**
 * The Teams side of D167: read chats/messages, search people, send text — all through the
 * dedicated window's own `fetch`, so cookies are the browser's business and no token is stored.
 *
 * Where the endpoints come from: the teams.microsoft.com web client's own traffic (`chatsvc` for
 * conversations, `mt/beta/users` for people). They are internal and may move; every call therefore
 * carries the URL and status into the log on failure, and the (token header, region) pair is
 * *discovered* at runtime instead of hardcoded — see `discover()`.
 *
 * Tokens (the `skype`/`chatsvc` JWT from `/api/authsvc/v1.0/authz`) live in this object's memory
 * only, with an expiry; nothing is written to disk and nothing is logged.
 */
import type { TeamsBrowser } from "./browser.ts";

export interface TeamsAuth {
  token: string;
  region: string;
  /** Which Authorization shape this tenant accepted — discovered, then reused. */
  header: AuthHeader;
}

export type AuthHeader = "bearer" | "bearer+x-skypetoken" | "skypetoken";

export interface TeamsChat {
  id: string;
  title: string;
  kind: "self" | "chat" | "meeting" | "channel";
  /** Last message time, ISO; absent when the conversation never had one. */
  lastActivity: string | null;
  preview: string;
}

export interface TeamsMessage {
  id: string;
  /** Sender MRI (`8:orgid:…`) — the same handle `teams_find` returns. */
  from: string;
  name: string;
  /** `YYYY-MM-DDTHH:MM:SS.sssZ`, as Teams reports `composetime`. */
  time: string;
  text: string;
}

export interface TeamsPerson {
  mri: string;
  name: string;
  email: string | null;
}

export interface PageResponse {
  status: number;
  text: string;
  url: string;
  opaqueredirect: boolean;
}

export const SELF_CHAT = "48:notes";

/** Error with a stable code the web layer and the MCP tool both pass through verbatim. */
export class TeamsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

const REGIONS = ["sea", "emea", "noam", "apac", "gcc"];
const HEADERS: AuthHeader[] = ["bearer+x-skypetoken", "bearer", "skypetoken"];
const ORIGIN = "https://teams.microsoft.com";

export class TeamsClient {
  private authCache: TeamsAuth | null = null;
  private authAt = 0;
  /** The window's session can expire while the bridge runs; re-probing every call would be slow. */
  private static readonly AUTH_TTL = 10 * 60_000;

  constructor(
    private readonly browser: TeamsBrowser,
    private readonly log: (line: string) => void,
  ) {}

  /** Forget the cached token — called when the page reports an expired session. */
  invalidate(): void {
    this.authCache = null;
    this.authAt = 0;
  }

  // ------------------------------------------------------------ transport

  /**
   * One `fetch` inside the Teams tab. The page must be on teams.microsoft.com, otherwise
   * `fetch` is a cross-origin call and the SPA's CSP/CORS would answer for us instead of Teams.
   */
  private async fetchPage(pathOrUrl: string, init: { method?: string; headers?: Record<string, string>; body?: string; redirect?: "follow" | "manual" } = {}): Promise<PageResponse> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : ORIGIN + pathOrUrl;
    const payload = {
      url,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body ?? null,
      redirect: init.redirect ?? "follow",
    };
    const script = `(async () => {
      const p = ${JSON.stringify(payload)};
      try {
        const r = await fetch(p.url, {
          method: p.method,
          headers: p.headers,
          body: p.body === null ? undefined : p.body,
          credentials: "include",
          cache: "no-store",
          redirect: p.redirect,
        });
        const text = r.type === "opaqueredirect" ? "" : await r.text();
        return { status: r.status, text, url: r.url || "", opaqueredirect: r.type === "opaqueredirect" };
      } catch (e) {
        return { status: 0, text: String(e && e.message || e), url: "", opaqueredirect: false };
      }
    })()`;
    return this.browser.evaluate<PageResponse>(script);
  }

  /**
   * Make sure the tab sits on teams.microsoft.com. After a logout the tab lands on
   * login.microsoftonline.com, where a fetch to the Teams API is a different origin.
   */
  private async ensureOrigin(): Promise<void> {
    const href = await this.browser.evaluate<string>("location.href").catch(() => "");
    if (href.startsWith(ORIGIN)) return;
    await this.browser.navigate(`${ORIGIN}/v2/`);
  }

  private async json<T>(path: string, init: Parameters<TeamsClient["fetchPage"]>[1] = {}): Promise<T> {
    const r = await this.fetchPage(path, init);
    if (r.status === 401 || r.status === 403 || r.opaqueredirect) {
      this.invalidate();
      throw new TeamsError("TEAMS_AUTH_EXPIRED", "Teams 登录态已失效，请在设置里重新登录");
    }
    if (r.status < 200 || r.status >= 300) {
      this.log(`teams: ${init.method ?? "GET"} ${path.split("?")[0]} → ${r.status} ${title(r.text).slice(0, 120)}`);
      throw new TeamsError("TEAMS_HTTP_" + r.status, `Teams 返回 ${r.status}`, title(r.text).slice(0, 300));
    }
    try {
      return JSON.parse(r.text) as T;
    } catch {
      throw new TeamsError("TEAMS_BAD_JSON", "Teams 返回的不是 JSON", title(r.text).slice(0, 300));
    }
  }

  // ------------------------------------------------------------ auth / region

  /**
   * Exchange the browser's cookies for an API token, then find out which region this tenant lives
   * in and which header shape the tenant accepts. Runs once per bridge run (and again after a
   * 401); the answers are cached.
   */
  async discover(force = false): Promise<TeamsAuth> {
    if (!force && this.authCache && Date.now() - this.authAt < TeamsClient.AUTH_TTL) return this.authCache;
    await this.ensureOrigin();
    const authz = await this.authz();
    if (!authz) throw new TeamsError("TEAMS_AUTH_EXPIRED", "Teams 登录态已失效，请在设置里重新登录");
    const errors: string[] = [];
    for (const header of HEADERS) {
      for (const region of authz.region ? [authz.region, ...REGIONS.filter((r) => r !== authz.region)] : REGIONS) {
        const path = `/api/chatsvc/${region}/v1/users/ME/conversations?view=msnp24Equivalent&pageSize=1`;
        const r = await this.fetchPage(path, { headers: this.authHeaders(authz.token, header) });
        if (r.status >= 200 && r.status < 300) {
          this.authCache = { token: authz.token, region, header };
          this.authAt = Date.now();
          this.log(`teams: region ${region}, auth header ${header}`);
          return this.authCache;
        }
        errors.push(`${header}/${region}: ${r.status || r.text.slice(0, 60)}`);
        if (r.status === 401 && header === HEADERS[0]) {
          // The token itself is dead — no point walking the matrix.
          this.invalidate();
          throw new TeamsError("TEAMS_AUTH_EXPIRED", "Teams 登录态已失效，请在设置里重新登录");
        }
      }
    }
    this.log(`teams: no region answered (${errors.slice(0, 5).join("; ")})`);
    throw new TeamsError("TEAMS_NO_REGION", "找不到可用的 Teams 区域", errors.slice(0, 5).join("; "));
  }

  private authHeaders(token: string, header: AuthHeader): Record<string, string> {
    if (header === "skypetoken") return { skypetoken: token };
    if (header === "bearer") return { authorization: `Bearer ${token}` };
    return { authorization: `Bearer ${token}`, "x-skypetoken": token };
  }

  /** Logged in? Returns the region when the session works, `null` when it does not. */
  async session(): Promise<{ ok: boolean; region?: string; reason?: string }> {
    try {
      const auth = await this.discover(true);
      return { ok: true, region: auth.region };
    } catch (err) {
      const e = err as TeamsError;
      return { ok: false, reason: e.code === "TEAMS_AUTH_EXPIRED" ? "needs-login" : e.message };
    }
  }

  /**
   * POST /api/authsvc/v1.0/authz — the same call the web client makes on boot. GET is the older
   * shape; both are tried because the difference costs one request and saves a support ticket.
   */
  private async authz(): Promise<{ token: string; region?: string } | null> {
    for (const init of [{ method: "POST", body: "{}" }, { method: "GET" }] as const) {
      const r = await this.fetchPage("/api/authsvc/v1.0/authz", {
        method: init.method,
        body: "body" in init ? init.body : undefined,
        headers: { "content-type": "application/json", accept: "application/json" },
      });
      if (r.status === 401 || r.opaqueredirect || /login\.microsoftonline\.com/.test(r.url)) return null;
      if (r.status < 200 || r.status >= 300) continue;
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(r.text) as Record<string, unknown>;
      } catch {
        continue;
      }
      const tokens = (body.tokens ?? {}) as Record<string, unknown>;
      const token = ["skype", "chatsvc", "chatsvcagg", "ic3", "registry"].map((k) => tokens[k]).find((v): v is string => typeof v === "string" && v.length > 20);
      if (!token) continue;
      const region = [body.region, tokens.region, body.userRegion].find((v): v is string => typeof v === "string" && /^[a-z]{3,4}$/.test(v));
      return { token, region };
    }
    return null;
  }

  // ------------------------------------------------------------ chats

  /** Recent conversations, most recent first (that is the order chatsvc returns). */
  async chats(limit = 20): Promise<TeamsChat[]> {
    const auth = await this.discover();
    const body = await this.json<{ conversations?: RawConversation[] }>(
      `/api/chatsvc/${auth.region}/v1/users/ME/conversations?view=msnp24Equivalent&pageSize=${clamp(limit, 1, 50)}`,
      { headers: this.authHeaders(auth.token, auth.header) },
    );
    return (body.conversations ?? []).slice(0, limit).map(toChat);
  }

  /** Messages, oldest → newest, for a conversation id or a chat title. */
  async messages(chatId: string, limit = 20): Promise<TeamsMessage[]> {
    const auth = await this.discover();
    const body = await this.json<{ messages?: RawMessage[] }>(
      `/api/chatsvc/${auth.region}/v1/users/ME/conversations/${encodeURIComponent(chatId)}/messages?view=msnp24Equivalent&pageSize=${clamp(limit, 1, 100)}`,
      { headers: this.authHeaders(auth.token, auth.header) },
    );
    return (body.messages ?? [])
      .filter((m) => typeof m.content === "string" && isChatMessage(m))
      .map(toMessage)
      .slice(-limit);
  }

  /**
   * Send text. `chatId` is resolved by the caller (service), which is also where the
   * "not your own chat → confirm" rule lives; this method only does the HTTP part.
   *
   * `clientmessageid` is Teams' own idempotency key: the web client generates it per send, and the
   * server drops a repeat. We hand the id back so the caller can prove what it sent.
   */
  async send(chatId: string, text: string): Promise<{ id: string; time: string }> {
    const auth = await this.discover();
    const payload = {
      content: `<p>${escapeHtml(text).replace(/\r?\n/g, "<br>")}</p>`,
      messagetype: "RichText/Html",
      contenttype: "text",
      clientmessageid: String(Date.now()),
    };
    const body = await this.json<RawMessage>(`/api/chatsvc/${auth.region}/v1/users/ME/conversations/${encodeURIComponent(chatId)}/messages`, {
      method: "POST",
      headers: { ...this.authHeaders(auth.token, auth.header), "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { id: String(body.id ?? payload.clientmessageid), time: String(body.composetime ?? new Date().toISOString()) };
  }

  // ------------------------------------------------------------ people

  /**
   * Directory search by name or e-mail. The web client uses `mt/<region>/beta/users`; when a
   * tenant has that path closed we fall back to the search service, then to matching the user's own
   * existing conversations — never to a guess.
   */
  async find(query: string): Promise<TeamsPerson[]> {
    const q = query.trim();
    if (!q) return [];
    const auth = await this.discover();
    const headers = this.authHeaders(auth.token, auth.header);
    const attempts: { path: string; pick: (b: RawUserSearch) => RawUser[] }[] = [
      {
        path: `/api/mt/${auth.region}/beta/users?search=${encodeURIComponent(q)}&pageSize=20&includeDLs=false`,
        pick: (b) => b.users ?? b.results ?? [],
      },
      {
        path: `/api/mt/part/${auth.region}/beta/users?search=${encodeURIComponent(q)}&pageSize=20`,
        pick: (b) => b.users ?? b.results ?? [],
      },
    ];
    for (const a of attempts) {
      try {
        const body = await this.json<RawUserSearch>(a.path, { headers });
        const people = a.pick(body).filter((u) => u.mri).map(toPerson);
        if (people.length) return people;
      } catch (err) {
        if ((err as TeamsError).code === "TEAMS_AUTH_EXPIRED") throw err;
        this.log(`teams: people search ${a.path.split("?")[0]} failed: ${(err as Error).message}`);
      }
    }
    // Last resort: the conversations the user already has, filtered by title.
    const needle = q.toLowerCase();
    const chats = (await this.chats(50)).filter((c) => c.kind !== "self" && c.title.toLowerCase().includes(needle));
    return chats.map((c) => ({ mri: "", name: c.title, email: null }));
  }

  /**
   * A 1:1 conversation with `mri`. Teams creates it on demand: POST to the conversations
   * collection with the member list. When the tenant refuses that, we look for an existing chat
   * with the same title and use it — still an explicit, single match.
   */
  async openDirect(mri: string, name = ""): Promise<string> {
    const auth = await this.discover();
    const headers = { ...this.authHeaders(auth.token, auth.header), "content-type": "application/json" };
    try {
      const body = await this.json<{ id?: string }>(`/api/chatsvc/${auth.region}/v1/users/ME/conversations`, {
        method: "POST",
        headers,
        body: JSON.stringify({ members: [{ mri, role: "User" }], properties: { threadType: "chat" } }),
      });
      if (body.id) return body.id;
    } catch (err) {
      if ((err as TeamsError).code === "TEAMS_AUTH_EXPIRED") throw err;
      this.log(`teams: open 1:1 with ${mri} failed: ${(err as Error).message}`);
    }
    if (!name) throw new TeamsError("TEAMS_NO_CHAT", "打不开这个人的会话", mri);
    const needle = name.trim().toLowerCase();
    const hit = (await this.chats(50)).filter((c) => c.kind !== "self" && c.title.trim().toLowerCase() === needle);
    if (hit.length === 1) return hit[0]!.id;
    throw new TeamsError("TEAMS_NO_CHAT", `没有和「${name}」的会话，也没能新建`, mri);
  }
}

// ---------------------------------------------------------------- raw shapes

interface RawConversation {
  id?: string;
  threadProperties?: { topic?: string; threadType?: string; productThreadType?: string };
  lastMessage?: { imdisplayname?: string; content?: string; composetime?: string; type?: string };
}

interface RawMessage {
  id?: string | number;
  type?: string;
  from?: string;
  imdisplayname?: string;
  content?: string;
  composetime?: string;
}

interface RawUser {
  mri?: string;
  displayName?: string;
  name?: string;
  email?: string;
  userPrincipalName?: string;
}

interface RawUserSearch {
  users?: RawUser[];
  results?: RawUser[];
}

// ---------------------------------------------------------------- parsing

function toChat(raw: RawConversation): TeamsChat {
  const id = String(raw.id ?? "");
  const props = raw.threadProperties ?? {};
  const kind: TeamsChat["kind"] =
    id === SELF_CHAT ? "self" : /channel|topic/i.test(props.threadType ?? "") ? "channel" : /meeting/i.test(props.productThreadType ?? "") ? "meeting" : "chat";
  const topic = props.topic?.trim();
  return {
    id,
    title: id === SELF_CHAT ? "与你自己的聊天" : topic || raw.lastMessage?.imdisplayname?.trim() || id,
    kind,
    lastActivity: raw.lastMessage?.composetime ?? null,
    preview: htmlToText(raw.lastMessage?.content ?? "").slice(0, 120),
  };
}

function toMessage(raw: RawMessage): TeamsMessage {
  return {
    id: String(raw.id ?? ""),
    from: String(raw.from ?? ""),
    name: String(raw.imdisplayname ?? ""),
    time: String(raw.composetime ?? ""),
    text: htmlToText(raw.content ?? ""),
  };
}

function toPerson(raw: RawUser): TeamsPerson {
  return {
    mri: String(raw.mri ?? ""),
    name: String(raw.displayName ?? raw.name ?? raw.email ?? raw.mri ?? ""),
    email: raw.email ?? raw.userPrincipalName ?? null,
  };
}

/** System rows (`ThreadActivity/*`, `Control/*`) are not conversation and would only be noise. */
function isChatMessage(m: RawMessage): boolean {
  if (!m.content) return false;
  const t = m.type ?? "Message";
  return t === "Message" || t === "RichText/Html" || t === "Text";
}

export function htmlToText(html: string): string {
  if (!html) return "";
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function title(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
