/**
 * Wiring between the bridge (HTTP routes, WS, notifier, MCP) and the Teams client (D167).
 *
 * Two rules live here, because both are policy rather than plumbing:
 *
 * 1. **Sending to somebody else needs a human.** `teams_send` may write to your own chat freely;
 *    for any other conversation the bridge asks the open page and waits for a click. No page
 *    present → refuse, and say so (`TEAMS_NEEDS_CONFIRM`) instead of quietly sending.
 * 2. **A push target is not a tool target.** The notifier writes to the chat you configured in
 *    settings without a dialog — you already decided where pushes go, and a push that needs a
 *    browser tab open to happen is not a push.
 */
import { readJson, statePath, writeJson } from "../paths.ts";
import { TeamsBrowser, installedBrowsers, type BrowserKind, type BrowserState } from "./browser.ts";
import { SELF_CHAT, TeamsClient, TeamsError, type TeamsChat, type TeamsMessage, type TeamsPerson } from "./client.ts";

export interface TeamsSettings {
  /** Which browser to open. Only the installed ones are offered; a stale value falls back. */
  browser: BrowserKind;
  /** The 通知 sub-switch (the master switch stays in pi 设置 → 通知). */
  notify: boolean;
  /** Where pushes go; a chat id. `48:notes` means your own chat. */
  target: string;
  targetTitle: string;
  /**
   * 这份 profile 里成功登录过一次。只有它为真，工具调用才允许**自己**把窗口拉起来：
   * 没登录过的 profile 起窗口只会停在登录页，那种「突然弹一个浏览器」谁也不想要。
   */
  everReady: boolean;
}

export interface TeamsTarget {
  id: string;
  title: string;
  self: boolean;
  /**
   * 会话类型。`channel` 这一版**不发也不读**：频道消息走的是
   * `/api/chatsvc/<region>/v1/teams/<team>/channels/<chan>/messages`，和私聊不是一套端点。
   * 静默发到错的地方比报错更糟，所以宁可说清楚。
   */
  kind: "self" | "chat" | "meeting" | "channel";
}

export interface TeamsConfirmRequest {
  /** Echoed back by the page so a stale click cannot approve a newer send. */
  id: string;
  to: TeamsTarget;
  text: string;
}

/** Handed in by index.ts: broadcast a confirm dialog and await the click (or timeout). */
export type Confirmer = (req: TeamsConfirmRequest) => Promise<boolean>;

export interface TeamsStatus {
  /** Can a tool call succeed right now, judged without starting anything. */
  reachable: boolean;
  state: BrowserState;
  error: string | null;
  /** Installed browsers on this machine — the settings select shows these. */
  browsers: BrowserKind[];
  browser: BrowserKind;
  notify: boolean;
  target: TeamsTarget;
  /** Whether `~/.pi/agent/mcp.json` already points at this bridge (checked by the caller). */
  mcpInstalled: boolean;
}

const MAX_TEXT = 8000;
const MIN_GAP_MS = 1000;

export class TeamsService {
  readonly browser: TeamsBrowser;
  readonly client: TeamsClient;
  private settings: TeamsSettings;
  private lastSendAt = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly log: (line: string) => void,
    private readonly confirm: Confirmer,
  ) {
    this.settings = this.load();
    this.browser = new TeamsBrowser(log);
    this.browser.setPreferred(this.settings.browser);
    this.client = new TeamsClient(this.browser, log);
  }

  private file(): string {
    return statePath("teams.json");
  }

  private load(): TeamsSettings {
    const raw = readJson<Partial<TeamsSettings>>(this.file(), {});
    const installed = installedBrowsers();
    const browser: BrowserKind = raw.browser === "chrome" || raw.browser === "edge" ? raw.browser : installed.includes("edge") ? "edge" : installed[0] ?? "edge";
    return {
      browser,
      notify: raw.notify !== false,
      target: typeof raw.target === "string" && raw.target ? raw.target : SELF_CHAT,
      targetTitle: typeof raw.targetTitle === "string" && raw.targetTitle ? raw.targetTitle : "与你自己的聊天",
      everReady: raw.everReady === true,
    };
  }

  private save(): void {
    writeJson(this.file(), this.settings);
  }

  settingsView(): TeamsSettings {
    return { ...this.settings };
  }

  target(): TeamsTarget {
    const self = this.settings.target === SELF_CHAT;
    return { id: this.settings.target, title: this.settings.targetTitle, self, kind: self ? "self" : "chat" };
  }

  async status(): Promise<TeamsStatus> {
    const reachable = await this.browser.reachable();
    return {
      reachable,
      state: reachable ? this.browser.state === "off" ? "needs-login" : this.browser.state : "off",
      error: this.browser.error,
      browsers: installedBrowsers(),
      browser: this.settings.browser,
      notify: this.settings.notify,
      target: this.target(),
      mcpInstalled: false,
    };
  }

  // ------------------------------------------------------------ settings

  setBrowser(kind: BrowserKind): TeamsSettings {
    if (kind !== this.settings.browser) {
      this.settings.browser = kind;
      this.browser.setPreferred(kind);
      this.save();
      this.log(`teams: browser → ${kind}`);
    }
    return this.settingsView();
  }

  setNotify(on: boolean): TeamsSettings {
    this.settings.notify = on;
    this.save();
    this.log(`teams: notify ${on ? "on" : "off"}`);
    return this.settingsView();
  }

  setTarget(id: string, title: string): TeamsTarget {
    this.settings.target = id || SELF_CHAT;
    this.settings.targetTitle = title || (this.settings.target === SELF_CHAT ? "与你自己的聊天" : id);
    this.save();
    this.log(`teams: push target → ${this.settings.target}`);
    return this.target();
  }

  // ------------------------------------------------------------ session

  /**
   * Open the window if needed, then ask Teams whether the cookies still work. Used by the login
   * button, by every tool call, and by the notify path — starting the browser is exactly what
   * "首次可见、之后常驻" means.
   */
  async login(): Promise<{ ok: boolean; state: BrowserState; reason?: string }> {
    try {
      await this.browser.ensure();
    } catch (err) {
      this.browser.state = "error";
      this.browser.error = (err as Error).message;
      return { ok: false, state: "error", reason: this.browser.error };
    }
    const session = await this.client.session();
    this.browser.state = session.ok ? "ready" : "needs-login";
    if (session.ok && !this.settings.everReady) {
      this.settings.everReady = true;
      this.save();
    }
    if (!session.ok && session.reason !== "needs-login") this.browser.error = session.reason ?? null;
    return { ok: session.ok, state: this.browser.state, reason: session.reason };
  }

  /** Human clicked 「登录」: make sure the window is front and on the Teams login page. */
  async openForLogin(): Promise<{ ok: boolean; state: BrowserState; reason?: string }> {
    try {
      await this.browser.openForLogin();
    } catch (err) {
      return { ok: false, state: "error", reason: (err as Error).message };
    }
    return this.login();
  }

  async logout(): Promise<void> {
    this.client.invalidate();
    await this.browser.stop(true);
  }

  /** Warm the session once at bridge boot — cheap when the window is not running. */
  async boot(): Promise<void> {
    if (!this.settings.target) return;
    if (!(await this.browser.reachable())) return;
    const session = await this.client.session();
    this.browser.state = session.ok ? "ready" : "needs-login";
    if (session.ok && !this.settings.everReady) {
      this.settings.everReady = true;
      this.save();
    }
  }

  // ------------------------------------------------------------ tools

  async chats(limit: number): Promise<TeamsChat[]> {
    await this.ready();
    return this.client.chats(limit);
  }

  async messages(chat: string, limit: number): Promise<{ chat: TeamsTarget; messages: TeamsMessage[] }> {
    await this.ready();
    const target = await this.resolve(chat);
    if (target.kind === "channel") throw new TeamsError("TEAMS_CHANNEL_UNSUPPORTED", `「${target.title}」是个频道：频道消息走另一套端点，这一版不读频道`);
    return { chat: target, messages: await this.client.messages(target.id, limit) };
  }

  async people(query: string): Promise<TeamsPerson[]> {
    await this.ready();
    return this.client.find(query);
  }

  /**
   * Resolve a user-supplied handle to a conversation. Accepted shapes, in order: empty (the push
   * target), `self`/`48:notes`, a raw conversation id, a chat title, a person's name.
   * Ambiguity is an error listing the candidates — guessing here sends to the wrong human.
   */
  async resolve(input: string | undefined): Promise<TeamsTarget> {
    const raw = (input ?? "").trim();
    if (!raw || /^(self|me|自己|我)$/i.test(raw)) return this.target();
    if (raw === SELF_CHAT) return { id: SELF_CHAT, title: "与你自己的聊天", self: true, kind: "self" };
    if (/^\d{1,3}:[0-9a-f@._-]+$/i.test(raw)) {
      const hit = (await this.client.chats(50).catch(() => [])).find((c) => c.id === raw);
      return { id: raw, title: hit?.title ?? raw, self: raw === SELF_CHAT, kind: hit?.kind ?? "chat" };
    }
    const needle = raw.toLowerCase();
    const chats = await this.client.chats(50);
    const exact = chats.filter((c) => c.title.trim().toLowerCase() === needle);
    if (exact.length === 1) return { id: exact[0]!.id, title: exact[0]!.title, self: exact[0]!.id === SELF_CHAT, kind: exact[0]!.kind };
    if (exact.length > 1) throw new TeamsError("TEAMS_AMBIGUOUS", `有 ${exact.length} 个会话都叫「${raw}」`, exact.map((c) => c.id).join(", "));
    const fuzzy = chats.filter((c) => c.title.toLowerCase().includes(needle));
    if (fuzzy.length === 1) return { id: fuzzy[0]!.id, title: fuzzy[0]!.title, self: fuzzy[0]!.id === SELF_CHAT, kind: fuzzy[0]!.kind };
    if (fuzzy.length > 1)
      throw new TeamsError("TEAMS_AMBIGUOUS", `「${raw}」匹配到 ${fuzzy.length} 个会话`, fuzzy.slice(0, 8).map((c) => c.title).join(" / "));

    // Not a chat — try the directory. One hit is a chat we may create/use; more than one is a question.
    const people = await this.client.find(raw);
    if (people.length === 0) throw new TeamsError("TEAMS_NO_MATCH", `没找到「${raw}」，聊天和联系人都没有`);
    if (people.length > 1) {
      const names = people.slice(0, 8).map((p) => p.name);
      throw new TeamsError("TEAMS_AMBIGUOUS", `「${raw}」匹配到 ${people.length} 个人`, names.join(" / "));
    }
    const person = people[0]!;
    if (!person.mri) {
      // Search fell back to conversation titles: the "person" is really that chat.
      const chat = chats.find((c) => c.title === person.name);
      if (chat) return { id: chat.id, title: chat.title, self: chat.id === SELF_CHAT, kind: chat.kind };
      throw new TeamsError("TEAMS_NO_CHAT", `只找到「${person.name}」这个名字，没有可发的会话`);
    }
    const id = await this.client.openDirect(person.mri, person.name);
    return { id, title: person.name, self: id === SELF_CHAT, kind: id === SELF_CHAT ? "self" : "chat" };
  }

  /**
   * The one write path. Serialised (Teams rate-limits a chat at ~1 msg/s) and gated on the
   * confirm dialog for every conversation that is not your own.
   */
  async send(input: string | undefined, text: string): Promise<{ chat: TeamsTarget; id: string; time: string }> {
    if (!text.trim()) throw new TeamsError("TEAMS_EMPTY", "没有要发的内容");
    if (text.length > MAX_TEXT) throw new TeamsError("TEAMS_TOO_LONG", `一次最多 ${MAX_TEXT} 个字符`);
    const run = async () => {
      await this.ready();
      const target = await this.resolve(input);
      if (target.kind === "channel") throw new TeamsError("TEAMS_CHANNEL_UNSUPPORTED", `「${target.title}」是个频道：频道消息走另一套端点，这一版不发到频道——换成私聊，或者让我在频道里回`);
      if (!target.self) {
        const ok = await this.confirm({ id: `snd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, to: target, text });
        if (!ok) throw new TeamsError("TEAMS_NOT_CONFIRMED", `没有在网页上确认发往「${target.title}」，已取消`);
      }
      const gap = MIN_GAP_MS - (Date.now() - this.lastSendAt);
      if (gap > 0) await sleep(gap);
      const sent = await this.client.send(target.id, text).catch((err: unknown) => {
        const e = err as TeamsError;
        // 404 在这里几乎总是「这个 id 不是这条会话的」：改过名、退过群、或者用了旧的 id。
        if (e.code === "TEAMS_HTTP_404") throw new TeamsError("TEAMS_CHAT_GONE", `发不进去：会话 id 可能已经失效（${target.id}）。先用 teams_chats 重新拿一次`);
        throw err;
      });
      this.lastSendAt = Date.now();
      // The log records the shape of the send, never the text: chat ids and lengths are enough to
      // debug, and chat contents do not belong in a file.
      this.log(`teams: sent to ${target.id} (${text.length} chars)`);
      return { chat: target, ...sent };
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Notification channel: writes to the configured target with no dialog. Returns the reason on
   * failure so `/api/notify-test` and the notifier can say *why* nothing arrived.
   */
  async notify(text: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.settings.notify) return { ok: false, reason: "off" };
    try {
      await this.ready();
      await this.client.send(this.settings.target, text);
      this.lastSendAt = Date.now();
      this.log(`teams: notify → ${this.settings.target} (${text.length} chars)`);
      return { ok: true };
    } catch (err) {
      const e = err as TeamsError;
      this.log(`teams: notify failed (${e.code ?? "ERR"}): ${e.message}`);
      return { ok: false, reason: e.code ?? e.message };
    }
  }

  /** Every tool path needs a live, authenticated window; this is the single gate. */
  private async ready(): Promise<void> {
    if (!(await this.browser.reachable())) {
      // 从没在这份 profile 里登录过：起窗口只会停在登录页，所以宁可直接说「窗口没开」，
      // 让人去设置里点那一次。登录过一次之后再被关掉，工具可以自己把它拉回来。
      if (!this.settings.everReady) {
        throw new TeamsError("TEAMS_OFF", "Teams 窗口没开：先到设置 → Teams 里点「打开窗口并登录」");
      }
      await this.browser.ensure();
    }
    try {
      await this.client.discover();
      this.browser.state = "ready";
      if (!this.settings.everReady) {
        this.settings.everReady = true;
        this.save();
      }
    } catch (err) {
      const e = err as TeamsError;
      this.browser.state = e.code === "TEAMS_AUTH_EXPIRED" ? "needs-login" : "error";
      this.browser.error = e.message;
      throw e;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
