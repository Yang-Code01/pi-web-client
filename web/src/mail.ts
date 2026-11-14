/**
 * 邮箱面板：顶栏「📮 邮箱」打开的那扇控制台。
 *
 * 版式照「设置 → 本机管理」：中间一块 1120×800 的对话框，左边分区导航（邮件 / 写邮件 /
 * 账号 / AI 权限 / 发送记录），右边是当前分区；顶栏放账号与策略摘要，底栏一句口径。
 * 邮箱的「账号」和「权限」本来就是两张要反复调的设置页，塞进一个滚动长页每次都要找。
 *
 * 两条边界（和 JiraPanel 一样）：
 * - 授权码只在桥那边，这里拿到的永远是掩码；页面不拼任何 IMAP/SMTP 连接。
 * - 每次 `open()` 都重新问桥，不信内存里的旧状态（换账号、改权限都能立刻反映）。
 *
 * 「让 AI 分析 / 起草」不直接调模型，只把一段 prompt 交给会话输入框（`host.handoff`）——
 * 发不发、怎么问，由用户决定。
 */
import { api } from "./api.ts";
import { createEl as el } from "./chat.ts";
import "./mail-console.css";
import { errText, tr } from "./i18n/index.ts";
import type {
  MailAccountInput,
  MailAccountView,
  MailConfigView,
  MailDetailView,
  MailEndpoint,
  MailFolderView,
  MailPolicyView,
  MailSummary,
} from "./mail-shared.ts";
import { MAIL_POLICY_LABELS, parseRecipients, sizeText, whenText } from "./mail-shared.ts";

export interface MailHandoff {
  prefill(text: string): void;
  newSessionWith(text: string): void;
}

export interface MailHost {
  handoff: MailHandoff;
}

type Section = "inbox" | "compose" | "accounts" | "policy" | "audit";

interface Compose {
  /** 回复原信时记下来源，发出去之后可以回到阅读区。 */
  replyToUid: number;
  to: string;
  cc: string;
  subject: string;
  text: string;
  draft: boolean;
  busy: boolean;
  error: string;
}

interface AccountForm {
  id?: string;
  label: string;
  address: string;
  preset: string;
  user: string;
  secret: string;
  imapHost: string;
  imapPort: string;
  smtpHost: string;
  smtpPort: string;
  advanced: boolean;
}

function emptyForm(preset: string, imap: MailEndpoint, smtp: MailEndpoint): AccountForm {
  return {
    label: "",
    address: "",
    preset,
    user: "",
    secret: "",
    imapHost: imap.host,
    imapPort: String(imap.port),
    smtpHost: smtp.host,
    smtpPort: String(smtp.port),
    advanced: false,
  };
}

function formOf(account: MailAccountView): AccountForm {
  return {
    id: account.id,
    label: account.label,
    address: account.address,
    preset: account.preset,
    user: account.user,
    secret: "",
    imapHost: account.imap.host,
    imapPort: String(account.imap.port),
    smtpHost: account.smtp.host,
    smtpPort: String(account.smtp.port),
    advanced: false,
  };
}

/** 「哪一步没成」+ 桥的错误：`errText` 只认一个参数，语境在自己这层加。 */
function failText(what: string, err: unknown): string {
  return tr("{what}：{why}", { what, why: errText(err) });
}

const SECTIONS: { id: Section; label: string }[] = [
  { id: "inbox", label: "邮件" },
  { id: "compose", label: "写邮件" },
  { id: "accounts", label: "账号" },
  { id: "policy", label: "AI 权限" },
  { id: "audit", label: "发送记录" },
];

export class MailPanel {
  private readonly host: MailHost;
  private root: HTMLElement | null = null;
  private lastFocus: HTMLElement | null = null;
  private esc: ((ev: KeyboardEvent) => void) | null = null;
  private seq = 0;

  private config: MailConfigView | null = null;
  private loadError = "";
  private notice = "";

  private section: Section = "inbox";
  /** 当前选中的账号 id；null = 用桥那边的默认账号。 */
  private account: string | null = null;
  private folders: MailFolderView[] = [];
  private folder = "INBOX";
  private messages: MailSummary[] = [];
  private listLoading = false;
  private listError = "";
  private unreadOnly = false;

  private detail: MailDetailView | null = null;
  private detailUid = -1;
  private detailLoading = false;
  private detailError = "";
  private attachmentsAllowed = true;

  private compose: Compose | null = null;
  private form: AccountForm | null = null;
  private saving = false;
  private formError = "";
  private testing = "";

  constructor(host: MailHost) {
    this.host = host;
  }

  open(): void {
    if (this.root) this.close();
    this.seq += 1;
    this.config = null;
    this.loadError = "";
    this.notice = "";
    this.section = "inbox";
    this.account = null;
    this.folders = [];
    this.folder = "INBOX";
    this.messages = [];
    this.listLoading = false;
    this.listError = "";
    this.unreadOnly = false;
    this.detail = null;
    this.detailUid = -1;
    this.detailLoading = false;
    this.detailError = "";
    this.compose = null;
    this.form = null;
    this.saving = false;
    this.formError = "";
    this.testing = "";
    this.lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.esc = (ev) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      this.close();
    };
    document.addEventListener("keydown", this.esc, true);
    this.render();
    void this.reload();
  }

  close(): void {
    if (this.esc) document.removeEventListener("keydown", this.esc, true);
    this.esc = null;
    this.seq += 1;
    this.root?.remove();
    this.root = null;
    const back = this.lastFocus;
    this.lastFocus = null;
    back?.focus();
  }

  /** 切换语言：整块重画。表单与草稿的值都在实例字段里，不会丢。 */
  refreshLang(): void {
    if (this.root) this.render();
  }

  // -------------------------------------------------------------- 取数

  private activeAccount(): MailAccountView | null {
    const accounts = this.config?.accounts ?? [];
    if (!accounts.length) return null;
    if (this.account) return accounts.find((a) => a.id === this.account) ?? accounts[0];
    return accounts.find((a) => a.id === this.config?.defaultAccount) ?? accounts[0];
  }

  private async reload(): Promise<void> {
    const seq = ++this.seq;
    try {
      const config = await api.mailConfig();
      if (seq !== this.seq || !this.root) return;
      this.config = config;
      this.loadError = "";
      if (!config.accounts.length) {
        // 一个账号都没有：直接摊开账号页的新增表单，别让人先找按钮。
        this.section = "accounts";
        this.form = emptyForm(config.presetIds[0] ?? "163", ...this.presetEndpoints(config, config.presetIds[0] ?? "163"));
        this.render();
        this.focusFirst();
        return;
      }
      this.render();
      await this.loadFolders(seq);
    } catch (err) {
      if (seq !== this.seq) return;
      this.loadError = failText(tr("打不开邮箱设置"), err);
      this.render();
    }
  }

  private presetEndpoints(config: MailConfigView, preset: string): [MailEndpoint, MailEndpoint] {
    const p = config.presets[preset];
    const fallback: MailEndpoint = { host: "", port: 993, secure: true };
    return [p?.imap ?? fallback, p?.smtp ?? { host: "", port: 465, secure: true }];
  }

  private async loadFolders(seq: number): Promise<void> {
    const account = this.activeAccount();
    if (!account) return;
    try {
      const { folders } = await api.mailFolders(account.id);
      if (seq !== this.seq || !this.root) return;
      this.folders = folders;
      const known = folders.some((f) => f.path === this.folder);
      if (!known) this.folder = folders.find((f) => f.kind === "inbox")?.path ?? folders[0]?.path ?? "INBOX";
      await this.loadMessages(seq);
    } catch (err) {
      if (seq !== this.seq) return;
      this.listError = failText(tr("拿不到邮件夹"), err);
      this.render();
    }
  }

  private async loadMessages(seq: number): Promise<void> {
    const account = this.activeAccount();
    if (!account) return;
    this.listLoading = true;
    this.render();
    try {
      const { messages } = await api.mailMessages({ account: account.id, folder: this.folder, limit: 30, unread: this.unreadOnly });
      if (seq !== this.seq || !this.root) return;
      this.messages = messages;
      this.listError = "";
    } catch (err) {
      if (seq !== this.seq) return;
      this.messages = [];
      this.listError = failText(tr("邮件列表拿不到"), err);
    } finally {
      if (seq === this.seq) {
        this.listLoading = false;
        this.render();
      }
    }
  }

  private async openMessage(uid: number): Promise<void> {
    const account = this.activeAccount();
    if (!account) return;
    const seq = this.seq;
    this.detailUid = uid;
    this.detailLoading = true;
    this.detailError = "";
    this.compose = null;
    this.render();
    try {
      const res = await api.mailMessage({ account: account.id, folder: this.folder, uid });
      if (seq !== this.seq || !this.root) return;
      this.detail = res.message;
      this.attachmentsAllowed = res.attachmentsAllowed;
      // 打开即已读是邮箱客户端的行为；本地列表跟着变一下，别等下一次刷新。
      this.messages = this.messages.map((m) => (m.uid === uid ? { ...m, unread: false } : m));
    } catch (err) {
      if (seq !== this.seq) return;
      this.detail = null;
      this.detailError = failText(tr("这封信读不出来"), err);
    } finally {
      if (seq === this.seq) {
        this.detailLoading = false;
        this.render();
      }
    }
  }

  private startReply(mode: "reply" | "draft"): void {
    const m = this.detail;
    const me = this.activeAccount();
    if (!m || !me) return;
    const subject = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;
    const quoted = m.text
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n");
    this.compose = {
      replyToUid: m.uid,
      to: m.from,
      cc: "",
      subject,
      text: mode === "draft" ? "\n\n" + tr("在 {when}，{from} 写道：", { when: whenText(m.date), from: m.from }) + "\n" + quoted : "",
      draft: false,
      busy: false,
      error: "",
    };
    this.section = "compose";
    this.render();
    window.setTimeout(() => {
      const box = this.root?.querySelector<HTMLTextAreaElement>(".mc-compose__text");
      box?.focus();
    }, 0);
  }

  private startNewMail(): void {
    this.compose = { replyToUid: -1, to: "", cc: "", subject: "", text: "", draft: false, busy: false, error: "" };
    this.section = "compose";
    this.render();
  }

  private async sendCompose(draft: boolean): Promise<void> {
    const box = this.compose;
    const account = this.activeAccount();
    if (!box || !account) return;
    if (!box.to.trim() || !box.subject.trim()) {
      box.error = tr("收件人和主题都得填");
      this.render();
      return;
    }
    box.busy = true;
    box.draft = draft;
    box.error = "";
    this.render();
    const seq = this.seq;
    try {
      const out = await api.mailSend({
        account: account.id,
        to: box.to,
        cc: box.cc,
        subject: box.subject,
        text: box.text,
        draft,
      });
      if (seq !== this.seq || !this.root) return;
      this.compose = null;
      this.notice = draft ? tr("已存进草稿箱") : tr("已发出：{id}", { id: out.messageId ?? "" });
      this.section = "inbox";
      void this.loadMessages(this.seq);
    } catch (err) {
      if (seq !== this.seq) return;
      box.busy = false;
      box.error = failText(draft ? tr("没存进草稿箱") : tr("没发出去"), err);
      this.render();
    }
  }

  private askAi(what: "analyze" | "reply" | "compose"): void {
    const account = this.activeAccount();
    if (!account) return;
    if (what === "compose") {
      const c = this.compose;
      if (!c) return;
      const lines = [
        tr("帮我写一封邮件，用 {account} 这个账号。", { account: account.address }),
        c.to ? tr("收件人：{v}", { v: c.to }) : "",
        c.cc ? tr("抄送：{v}", { v: c.cc }) : "",
        c.subject ? tr("主题：{v}", { v: c.subject }) : "",
        c.text ? tr("我的开头：{v}", { v: c.text }) : "",
        tr("写好之后用 mail_draft 存进草稿箱，先别发。"),
      ].filter(Boolean);
      this.host.handoff.prefill(lines.join("\n"));
      this.notice = tr("已放进输入框，回车前可以再改");
      this.render();
      return;
    }
    const m = this.detail;
    if (!m) return;
    const where = tr("{account} 的 {folder} 文件夹", { account: account.address, folder: this.folder });
    const head = tr("用 mail_read 读一下 {where} 里 uid={uid} 这封邮件（主题：{subject}）。", {
      where,
      uid: String(m.uid),
      subject: m.subject,
    });
    const text =
      what === "analyze"
        ? head + "\n\n" + tr("然后告诉我：这封信要我做什么、有没有时限、需不需要回复。")
        : head + "\n\n" + tr("然后写一封回复草稿（用 mail_draft 存进草稿箱），先别发，等我确认。");
    this.host.handoff.prefill(text);
    this.notice = tr("已放进输入框，回车前可以再改");
    this.render();
  }

  // -------------------------------------------------------------- 外壳

  private render(): void {
    const back = el("div", "mc-back");
    back.addEventListener("mousedown", (ev) => {
      if (ev.target === back) this.close();
    });
    const shell = el("section", "mc-console");
    shell.setAttribute("role", "dialog");
    shell.setAttribute("aria-modal", "true");
    shell.setAttribute("aria-label", tr("邮箱"));

    shell.append(this.headEl(), this.bannerEl(), this.mainEl(), this.footEl());
    back.append(shell);
    this.root?.remove();
    this.root = back;
    document.body.append(back);
  }

  private headEl(): HTMLElement {
    const head = el("header", "mc-head");
    const main = el("div", "mc-head__main");
    main.append(el("div", "mc-eyebrow", tr("邮箱")));
    main.append(el("h2", "mc-title", tr("我的邮箱")));
    main.append(el("div", "mc-sub", this.config ? this.headSub() : tr("正在读设置…")));

    const badges = el("div", "mc-badges");
    if (this.config) {
      const n = this.config.accounts.length;
      badges.append(this.badge(tr("{n} 个账号", { n: String(n) }), n ? "" : "warn"));
      const unverified = this.config.accounts.filter((a) => !a.verifiedAt).length;
      if (unverified) badges.append(this.badge(tr("{n} 个未验证", { n: String(unverified) }), "warn"));
      badges.append(this.badge(this.policyBadge(), this.config.policy.send ? "" : "warn"));
      for (const a of this.config.accounts.slice(0, 3)) if (a.label) badges.append(this.badge(a.label, ""));
    }
    main.append(badges);

    const actions = el("div", "mc-head__actions");
    const refresh = el("button", "btn ghost", tr("刷新")) as HTMLButtonElement;
    refresh.type = "button";
    refresh.onclick = () => {
      this.notice = "";
      void this.reload();
    };
    const close = el("button", "btn ghost mc-close", tr("关闭")) as HTMLButtonElement;
    close.type = "button";
    close.onclick = () => this.close();
    actions.append(refresh, close);

    head.append(main, actions);
    return head;
  }

  private badge(text: string, tone: "" | "warn"): HTMLElement {
    return el("span", tone ? "mc-badge mc-badge--warn" : "mc-badge", text);
  }

  private policyBadge(): string {
    const p = this.config?.policy;
    if (!p) return "";
    if (!p.send) return tr("AI 只能读");
    return p.confirmSend ? tr("AI 发信前会问你") : tr("AI 可以直接发");
  }

  private bannerEl(): HTMLElement {
    const box = el("div", "mc-banners");
    if (this.loadError) box.append(el("div", "mc-banner mc-banner--bad", this.loadError));
    if (this.notice) box.append(el("div", "mc-banner mc-banner--ok", this.notice));
    return box;
  }

  private mainEl(): HTMLElement {
    const main = el("div", "mc-main");
    const nav = el("nav", "mc-nav");
    nav.setAttribute("aria-label", tr("邮箱分区"));
    const counts: Partial<Record<Section, number>> = {
      accounts: this.config?.accounts.length ?? 0,
      inbox: this.messages.length,
      audit: this.config?.audit.length ?? 0,
    };
    for (const item of SECTIONS) {
      const btn = el("button", this.section === item.id ? "mc-nav__item on" : "mc-nav__item") as HTMLButtonElement;
      btn.type = "button";
      btn.append(el("span", "", tr(item.label)));
      const n = counts[item.id];
      if (n) btn.append(el("span", "mc-nav__count", String(n)));
      btn.onclick = () => {
        if (this.section === item.id) return;
        this.section = item.id;
        this.notice = "";
        if (item.id === "compose" && !this.compose) this.compose = { replyToUid: -1, to: "", cc: "", subject: "", text: "", draft: false, busy: false, error: "" };
        this.render();
        if (item.id === "inbox" && this.config?.accounts.length && !this.folders.length) void this.loadFolders(this.seq);
      };
      nav.append(btn);
    }

    const pane = el("div", "mc-pane");
    if (!this.config && this.loadError) pane.append(this.loadFailEl());
    else if (!this.config) pane.append(el("div", "mc-empty", tr("正在读设置…")));
    else if (this.section === "inbox") pane.append(this.inboxEl());
    else if (this.section === "compose") pane.append(this.composeEl());
    else if (this.section === "accounts") pane.append(this.accountsEl());
    else if (this.section === "policy") pane.append(this.policyEl());
    else pane.append(this.auditEl());

    main.append(nav, pane);
    return main;
  }

  private footEl(): HTMLElement {
    const foot = el("footer", "mc-foot");
    foot.append(el("span", "mc-foot__hint", tr("授权码只存在本机，页面看到的是掩码；发信的权限在「AI 权限」里。" )));
    foot.append(el("span", "mc-foot__meta", "pi-web-client"));
    return foot;
  }

  private loadFailEl(): HTMLElement {
    const box = el("div", "mc-empty");
    box.append(el("p", "", this.loadError));
    const retry = el("button", "btn", tr("重试")) as HTMLButtonElement;
    retry.type = "button";
    retry.onclick = () => {
      this.loadError = "";
      this.render();
      void this.reload();
    };
    box.append(retry);
    return box;
  }

  private headSub(): string {
    const accounts = this.config?.accounts ?? [];
    const me = this.activeAccount();
    if (!accounts.length) return tr("还没有账号 —— 先加一个");
    const bits: string[] = [];
    if (me) bits.push(me.address + (me.verifiedAt ? "" : tr("（未验证）")));
    if (me) bits.push(`${me.imap.host} / ${me.smtp.host}`);
    return bits.join(" · ");
  }

  // -------------------------------------------------------------- 邮件

  private inboxEl(): HTMLElement {
    const wrap = el("div", "mc-inbox");
    const bar = el("div", "mc-toolbar");
    const me = this.activeAccount();
    const accounts = this.config?.accounts ?? [];

    if (accounts.length > 1) {
      const pick = el("select", "mc-select") as HTMLSelectElement;
      pick.setAttribute("aria-label", tr("账号"));
      for (const a of accounts) {
        const opt = el("option", "", `${a.label} · ${a.address}`) as HTMLOptionElement;
        opt.value = a.id;
        if (me?.id === a.id) opt.selected = true;
        pick.append(opt);
      }
      pick.onchange = () => {
        this.account = pick.value;
        this.folders = [];
        this.messages = [];
        this.detail = null;
        this.detailUid = -1;
        this.render();
        void this.loadFolders(this.seq);
      };
      bar.append(pick);
    }

    const chips = el("div", "mc-chips");
    for (const f of this.folders) {
      const chip = el("button", f.path === this.folder ? "mc-chip on" : "mc-chip") as HTMLButtonElement;
      chip.type = "button";
      chip.append(el("span", "", f.name));
      chip.onclick = () => {
        if (f.path === this.folder) return;
        this.folder = f.path;
        this.detail = null;
        this.detailUid = -1;
        this.compose = null;
        this.messages = [];
        void this.loadMessages(this.seq);
      };
      chips.append(chip);
    }
    if (!this.folders.length && !this.listError) chips.append(el("span", "mc-hint", tr("正在读邮件夹…")));
    bar.append(chips);

    const spacer = el("div", "mc-toolbar__spacer");
    bar.append(spacer);

    const unread = el("label", "mc-check");
    const cb = el("input") as HTMLInputElement;
    cb.type = "checkbox";
    cb.checked = this.unreadOnly;
    cb.onchange = () => {
      this.unreadOnly = cb.checked;
      void this.loadMessages(this.seq);
    };
    unread.append(cb, el("span", "", tr("只看未读")));
    bar.append(unread);

    const refresh = el("button", "mc-mini", tr("刷新")) as HTMLButtonElement;
    refresh.type = "button";
    refresh.onclick = () => void this.loadMessages(this.seq);
    const write = el("button", "mc-mini mc-mini--primary", tr("写邮件")) as HTMLButtonElement;
    write.type = "button";
    write.onclick = () => this.startNewMail();
    bar.append(refresh, write);

    const split = el("div", "mc-split");
    split.append(this.listEl(), this.readEl());
    wrap.append(bar, split);
    return wrap;
  }

  private listEl(): HTMLElement {
    const list = el("div", "mc-list");
    if (this.listError) {
      const box = el("div", "mc-empty mc-empty--bad");
      box.append(el("p", "", this.listError));
      const retry = el("button", "mc-mini", tr("重试")) as HTMLButtonElement;
      retry.type = "button";
      retry.onclick = () => void this.loadFolders(this.seq);
      box.append(retry);
      list.append(box);
    } else if (this.listLoading && !this.messages.length) list.append(el("div", "mc-hint", tr("正在读邮件…")));
    else if (this.messages.length === 0)
      list.append(el("div", "mc-hint", this.unreadOnly ? tr("没有未读邮件") : tr("这个文件夹是空的")));
    else {
      for (const m of this.messages) {
        const row = el("button", m.uid === this.detailUid ? "mc-row is-on" : "mc-row") as HTMLButtonElement;
        row.type = "button";
        const top = el("div", "mc-row__top");
        top.append(el("span", m.unread ? "mc-dot" : "mc-dot mc-dot--off"));
        top.append(el("span", "mc-row__from", m.from || tr("（未知发件人）")));
        top.append(el("span", "mc-row__when", whenText(m.date)));
        row.append(top);
        const mid = el("div", "mc-row__subject");
        if (m.hasAttachments) mid.append(el("span", "mc-row__clip", "📎"));
        mid.append(document.createTextNode(m.subject || tr("（无主题）")));
        row.append(mid);
        row.onclick = () => void this.openMessage(m.uid);
        list.append(row);
      }
    }
    return list;
  }

  private readEl(): HTMLElement {
    const right = el("div", "mc-read");
    if (this.detailLoading) right.append(el("div", "mc-empty", tr("正在读这封信…")));
    else if (this.detailError) right.append(el("div", "mc-empty mc-empty--bad", this.detailError));
    else if (this.detail) right.append(this.detailEl(this.detail));
    else right.append(el("div", "mc-empty", tr("选一封邮件读，或者写一封新的")));
    return right;
  }

  private detailEl(m: MailDetailView): HTMLElement {
    const box = el("article", "mc-letter");
    box.append(el("h3", "mc-letter__subject", m.subject || tr("（无主题）")));
    const meta = el("div", "mc-letter__meta");
    meta.append(el("span", "", tr("发件人：{v}", { v: m.from })));
    if (m.to.length) meta.append(el("span", "", tr("收件人：{v}", { v: m.to.join(", ") })));
    if (m.cc.length) meta.append(el("span", "", tr("抄送：{v}", { v: m.cc.join(", ") })));
    meta.append(el("span", "", whenText(m.date)));
    box.append(meta);

    const acts = el("div", "mc-acts");
    const reply = el("button", "mc-mini", tr("回复")) as HTMLButtonElement;
    reply.type = "button";
    reply.onclick = () => this.startReply("reply");
    const draft = el("button", "mc-mini", tr("写草稿")) as HTMLButtonElement;
    draft.type = "button";
    draft.onclick = () => this.startReply("draft");
    const analyze = el("button", "mc-mini", tr("让 AI 分析")) as HTMLButtonElement;
    analyze.type = "button";
    analyze.onclick = () => this.askAi("analyze");
    const aiReply = el("button", "mc-mini", tr("让 AI 起草回复")) as HTMLButtonElement;
    aiReply.type = "button";
    aiReply.onclick = () => this.askAi("reply");
    acts.append(reply, draft, analyze, aiReply);
    box.append(acts);

    if (m.attachments.length) {
      const att = el("div", "mc-attach");
      att.append(el("div", "mc-attach__title", this.attachmentsAllowed ? tr("附件") : tr("附件（取附件权限关着）")));
      for (const a of m.attachments) {
        if (!this.attachmentsAllowed) {
          att.append(el("div", "mc-attach__row", `${a.filename} · ${sizeText(a.size)}`));
          continue;
        }
        const link = el("a", "mc-attach__row", `${a.filename} · ${sizeText(a.size)}`) as HTMLAnchorElement;
        link.href = api.mailAttachmentUrl({
          account: this.activeAccount()?.id,
          folder: this.folder,
          uid: m.uid,
          index: a.index,
        });
        link.setAttribute("download", a.filename);
        att.append(link);
      }
      box.append(att);
    }

    box.append(el("pre", "mc-letter__text", m.text || tr("（没有纯文本正文）")));
    return box;
  }

  // -------------------------------------------------------------- 写信

  private composeEl(): HTMLElement {
    if (!this.compose) {
      const empty = el("div", "mc-empty");
      empty.append(el("p", "", tr("还没有要写的信")));
      const start = el("button", "btn", tr("写一封新的")) as HTMLButtonElement;
      start.type = "button";
      start.onclick = () => this.startNewMail();
      empty.append(start);
      return empty;
    }
    const c = this.compose;
    const box = el("form", "mc-compose");
    box.addEventListener("submit", (ev) => ev.preventDefault());
    box.append(el("h3", "mc-letter__subject", c.replyToUid >= 0 ? tr("回复") : tr("新邮件")));

    const field = (label: string, value: string, key: "to" | "cc" | "subject"): HTMLElement => {
      const row = el("label", "mc-field");
      row.append(el("span", "mc-field__label", label));
      const input = el("input", "mc-input") as HTMLInputElement;
      input.type = "text";
      input.value = value;
      input.oninput = () => {
        (c as any)[key] = input.value;
      };
      row.append(input);
      return row;
    };
    const grid = el("div", "mc-form__grid");
    grid.append(field(tr("收件人"), c.to, "to"), field(tr("抄送"), c.cc, "cc"));
    box.append(grid, field(tr("主题"), c.subject, "subject"));

    const ta = el("textarea", "mc-compose__text") as HTMLTextAreaElement;
    ta.value = c.text;
    ta.rows = 14;
    ta.setAttribute("aria-label", tr("正文"));
    ta.oninput = () => {
      c.text = ta.value;
    };
    box.append(ta);
    if (c.error) box.append(el("div", "mc-hint mc-hint--bad", c.error));

    const acts = el("div", "mc-acts");
    const send = el("button", "mc-btn mc-btn--primary", c.busy ? tr("发送中…") : tr("发送")) as HTMLButtonElement;
    send.type = "button";
    send.disabled = c.busy;
    send.onclick = () => void this.sendCompose(false);
    const save = el("button", "mc-btn", tr("存草稿")) as HTMLButtonElement;
    save.type = "button";
    save.disabled = c.busy;
    save.onclick = () => void this.sendCompose(true);
    const ai = el("button", "mc-btn", tr("让 AI 帮我写")) as HTMLButtonElement;
    ai.type = "button";
    ai.onclick = () => this.askAi("compose");
    const cancel = el("button", "mc-btn", tr("取消")) as HTMLButtonElement;
    cancel.type = "button";
    cancel.onclick = () => {
      this.compose = null;
      this.section = "inbox";
      this.render();
    };
    acts.append(send, save, ai, cancel);
    box.append(acts);
    return box;
  }

  // -------------------------------------------------------------- 账号

  private accountsEl(): HTMLElement {
    const cfg = this.config!;
    const wrap = el("div", "mc-stack");

    const sec = el("section", "mc-section");
    const head = el("div", "mc-section__head");
    head.append(el("div", "mc-section__label", tr("账号")));
    head.append(el("div", "mc-section__meta", tr("授权码只存本机；页面只拿掩码")));
    sec.append(head);

    if (!cfg.accounts.length) sec.append(el("div", "mc-empty", tr("加一个邮箱账号，AI 才有邮可读")));
    else {
      const table = el("table", "mc-table");
      const thead = el("thead");
      const thr = el("tr");
      for (const h of [tr("邮箱"), tr("显示名"), tr("服务器"), tr("状态"), tr("操作")]) thr.append(el("th", "", h));
      thead.append(thr);
      table.append(thead);
      const tbody = el("tbody");
      for (const a of cfg.accounts) {
        const tr1 = el("tr");
        tr1.append(el("td", "mc-table__mono", a.address));
        tr1.append(el("td", "", a.label));
        tr1.append(el("td", "mc-table__mono", `${a.imap.host}:${a.imap.port} / ${a.smtp.host}:${a.smtp.port}`));
        const status = el("td", "");
        status.append(
          a.verifiedAt
            ? el("span", "mc-tag mc-tag--ok", tr("已验证"))
            : el("span", "mc-tag", a.lastError ? tr("连接失败") : tr("未验证")),
        );
        if (a.lastError) status.append(el("div", "mc-table__err", a.lastError));
        tr1.append(status);
        const ops = el("td", "mc-table__ops");
        const test = el("button", "mc-mini", this.testing === a.id ? tr("正在连…") : tr("验证")) as HTMLButtonElement;
        test.type = "button";
        test.disabled = this.testing === a.id;
        test.onclick = () => void this.testAccount(a.id);
        const edit = el("button", "mc-mini", tr("改")) as HTMLButtonElement;
        edit.type = "button";
        edit.onclick = () => {
          this.form = formOf(a);
          this.formError = "";
          this.render();
          this.focusFirst();
        };
        const del = el("button", "mc-mini mc-mini--bad", tr("删")) as HTMLButtonElement;
        del.type = "button";
        del.onclick = () => void this.deleteAccount(a.id);
        ops.append(test, edit, del);
        tr1.append(ops);
        tbody.append(tr1);
      }
      table.append(tbody);
      sec.append(table);
    }

    if (!this.form) {
      const add = el("button", "btn mc-section__action", tr("添加账号")) as HTMLButtonElement;
      add.type = "button";
      add.onclick = () => {
        this.form = emptyForm(cfg.presetIds[0] ?? "163", ...this.presetEndpoints(cfg, cfg.presetIds[0] ?? "163"));
        this.formError = "";
        this.render();
        this.focusFirst();
      };
      sec.append(add);
    }
    wrap.append(sec);
    if (this.form) wrap.append(this.formEl(this.form));
    return wrap;
  }

  private formEl(f: AccountForm): HTMLElement {
    const cfg = this.config!;
    const box = el("section", "mc-section mc-section--form");
    const head = el("div", "mc-section__head");
    head.append(el("div", "mc-section__label", f.id ? tr("改账号") : tr("新账号")));
    head.append(el("div", "mc-section__meta", tr("授权码不是登录密码")));
    box.append(head);

    const input = (label: string, value: string, type = "text", oninput?: (v: string) => void): HTMLElement => {
      const row = el("label", "mc-field");
      row.append(el("span", "mc-field__label", label));
      const inp = el("input", "mc-input") as HTMLInputElement;
      inp.type = type;
      inp.value = value;
      inp.oninput = () => oninput?.(inp.value);
      row.append(inp);
      return row;
    };

    const grid = el("div", "mc-form__grid");
    grid.append(input(tr("邮箱地址"), f.address, "email", (v) => (f.address = v)));
    grid.append(input(tr("显示名"), f.label, "text", (v) => (f.label = v)));
    box.append(grid);

    const presetRow = el("label", "mc-field");
    presetRow.append(el("span", "mc-field__label", tr("邮箱类型")));
    const pick = el("select", "mc-select") as HTMLSelectElement;
    for (const id of cfg.presetIds) {
      const opt = el("option", "", id === "custom" ? tr("自定义（手动填服务器）") : (cfg.presets[id]?.label ?? id)) as HTMLOptionElement;
      opt.value = id;
      opt.selected = f.preset === id;
      pick.append(opt);
    }
    pick.onchange = () => {
      f.preset = pick.value;
      const [imap, smtp] = this.presetEndpoints(cfg, pick.value);
      f.imapHost = imap.host;
      f.imapPort = String(imap.port);
      f.smtpHost = smtp.host;
      f.smtpPort = String(smtp.port);
      this.render();
      this.focusFirst();
    };
    presetRow.append(pick);
    box.append(presetRow);

    const creds = el("div", "mc-form__grid");
    creds.append(
      input(tr("登录账号（多数就是地址全称）"), f.user, "text", (v) => (f.user = v)),
      input(tr("客户端授权码"), f.secret, "password", (v) => (f.secret = v)),
    );
    box.append(creds);
    box.append(
      el(
        "div",
        "mc-hint",
        f.id && this.config?.accounts.find((a) => a.id === f.id)?.hasSecret
          ? tr("留空 = 不改授权码。密码不是授权码：要到邮箱网页版的「设置 → POP3/SMTP/IMAP」里单独生成。")
          : tr("要填客户端授权码（16 位），不是登录密码。到邮箱网页版的「设置 → POP3/SMTP/IMAP」里开启服务并生成。"),
      ),
    );

    const adv = el("button", "mc-mini", f.advanced ? tr("收起服务器设置") : tr("服务器设置")) as HTMLButtonElement;
    adv.type = "button";
    adv.onclick = () => {
      f.advanced = !f.advanced;
      this.render();
    };
    box.append(adv);
    if (f.advanced) {
      const advGrid = el("div", "mc-form__grid");
      advGrid.append(
        input(tr("IMAP 服务器"), f.imapHost, "text", (v) => (f.imapHost = v)),
        input(tr("IMAP 端口"), f.imapPort, "number", (v) => (f.imapPort = v)),
        input(tr("SMTP 服务器"), f.smtpHost, "text", (v) => (f.smtpHost = v)),
        input(tr("SMTP 端口"), f.smtpPort, "number", (v) => (f.smtpPort = v)),
      );
      box.append(advGrid);
    }

    if (this.formError) box.append(el("div", "mc-hint mc-hint--bad", this.formError));
    const acts = el("div", "mc-acts");
    const save = el("button", "mc-btn mc-btn--primary", this.saving ? tr("保存中…") : tr("保存")) as HTMLButtonElement;
    save.type = "button";
    save.disabled = this.saving;
    save.onclick = () => void this.saveAccount(f);
    const cancel = el("button", "mc-btn", tr("取消")) as HTMLButtonElement;
    cancel.type = "button";
    cancel.onclick = () => {
      this.form = null;
      this.formError = "";
      this.render();
    };
    acts.append(save, cancel);
    box.append(acts);
    return box;
  }

  // -------------------------------------------------------------- 权限

  private policyEl(): HTMLElement {
    const cfg = this.config!;
    const wrap = el("div", "mc-stack");

    const switches = el("section", "mc-section");
    const head = el("div", "mc-section__head");
    head.append(el("div", "mc-section__label", tr("AI 能做什么")));
    head.append(el("div", "mc-section__meta", tr("改一下就存，不用点保存")));
    switches.append(head);
    // 「改邮箱状态」桥端有字段，但 v1 还没有对应动作（标已读、归档、删除都没做）。
    // 放一个按了却什么也不变的开关，比不放更糟，所以这里先不给它位置。
    for (const item of MAIL_POLICY_LABELS.filter((one) => one.key !== "mutate")) {
      const row = el("label", "mc-switch");
      const cb = el("input") as HTMLInputElement;
      cb.type = "checkbox";
      cb.checked = Boolean(cfg.policy[item.key]);
      cb.onchange = () => void this.savePolicy({ [item.key]: cb.checked } as Partial<MailPolicyView>);
      const text = el("span", "mc-switch__body");
      text.append(el("span", "mc-switch__label", tr(item.label)));
      text.append(el("span", "mc-switch__hint", tr(item.hint)));
      row.append(cb, text);
      switches.append(row);
    }
    wrap.append(switches);

    const send = el("section", "mc-section");
    const shead = el("div", "mc-section__head");
    shead.append(el("div", "mc-section__label", tr("发信范围")));
    shead.append(el("div", "mc-section__meta", tr("只约束 AI；你自己点的不受限")));
    send.append(shead);

    const limitRow = el("label", "mc-field");
    limitRow.append(el("span", "mc-field__label", tr("每天最多发几封")));
    const limit = el("input", "mc-input") as HTMLInputElement;
    limit.type = "number";
    limit.min = "0";
    limit.value = String(cfg.policy.dailySendLimit);
    limit.onchange = () => {
      const n = Number(limit.value);
      void this.savePolicy({ dailySendLimit: Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0 });
    };
    limitRow.append(limit);
    send.append(limitRow);
    send.append(el("div", "mc-hint", tr("0 表示不限；只算 AI 发的，你自己点的不算")));

    const rcptRow = el("label", "mc-field");
    rcptRow.append(el("span", "mc-field__label", tr("只允许发给（一行一个，留空=谁都能发）")));
    const rcpt = el("textarea", "mc-input mc-input--area") as HTMLTextAreaElement;
    rcpt.rows = 3;
    rcpt.value = cfg.policy.recipients.join("\n");
    rcpt.onchange = () => void this.savePolicy({ recipients: parseRecipients(rcpt.value) });
    rcptRow.append(rcpt);
    send.append(rcptRow);

    if (cfg.accounts.length > 1) {
      const accRow = el("div", "mc-field");
      accRow.append(el("span", "mc-field__label", tr("AI 能用哪些账号（都不勾 = 全部）")));
      const list = el("div", "mc-checklist");
      for (const a of cfg.accounts) {
        const label = el("label", "mc-check");
        const cb = el("input") as HTMLInputElement;
        cb.type = "checkbox";
        cb.checked = cfg.policy.accountIds.includes(a.id);
        cb.onchange = () => {
          const next = new Set(cfg.policy.accountIds);
          if (cb.checked) next.add(a.id);
          else next.delete(a.id);
          void this.savePolicy({ accountIds: [...next] });
        };
        label.append(cb, el("span", "", `${a.label} · ${a.address}`));
        list.append(label);
      }
      accRow.append(list);
      send.append(accRow);
    }
    wrap.append(send);
    return wrap;
  }

  // -------------------------------------------------------------- 记录

  private auditEl(): HTMLElement {
    const cfg = this.config!;
    const sec = el("section", "mc-section");
    const head = el("div", "mc-section__head");
    head.append(el("div", "mc-section__label", tr("最近发出去的")));
    head.append(el("div", "mc-section__meta", tr("只留发出与失败的记录，不进模型上下文")));
    sec.append(head);

    if (!cfg.audit.length) sec.append(el("div", "mc-empty", tr("还没有记录")));
    else {
      const table = el("table", "mc-table");
      const thead = el("thead");
      const thr = el("tr");
      for (const h of [tr("时间"), tr("收件人"), tr("主题"), tr("发起者"), tr("结果")]) thr.append(el("th", "", h));
      thead.append(thr);
      table.append(thead);
      const tbody = el("tbody");
      for (const row of cfg.audit) {
        const tr1 = el("tr", row.ok ? "" : "is-bad");
        tr1.append(el("td", "mc-table__mono", whenText(row.t)));
        tr1.append(el("td", "", (row.to ?? []).join(", ")));
        tr1.append(el("td", "", row.subject));
        tr1.append(el("td", "", row.by === "agent" ? tr("AI") : tr("我")));
        tr1.append(el("td", "", row.ok ? tr("已发出") : (row.error ?? tr("失败"))));
        tbody.append(tr1);
      }
      table.append(tbody);
      sec.append(table);
    }
    return sec;
  }

  private focusFirst(): void {
    window.setTimeout(() => {
      this.root?.querySelector<HTMLInputElement>(".mc-section--form .mc-input")?.focus();
    }, 0);
  }

  // -------------------------------------------------------------- 写

  private async saveAccount(f: AccountForm): Promise<void> {
    if (!f.address.trim()) {
      this.formError = tr("邮箱地址不能空");
      this.render();
      return;
    }
    this.saving = true;
    this.formError = "";
    this.render();
    const seq = this.seq;
    const body: MailAccountInput = {
      label: f.label.trim() || f.address.trim(),
      address: f.address.trim(),
      preset: f.preset,
      user: f.user.trim() || f.address.trim(),
      secret: f.secret,
      imap: { host: f.imapHost.trim(), port: Number(f.imapPort) || 993, secure: true },
      smtp: { host: f.smtpHost.trim(), port: Number(f.smtpPort) || 465, secure: !f.smtpPort.startsWith("587") },
    };
    if (f.id) body.id = f.id;
    try {
      await api.mailSaveAccount(body);
      if (seq !== this.seq) return;
      this.form = null;
      this.notice = tr("账号已保存");
      await this.reload();
    } catch (err) {
      if (seq !== this.seq) return;
      this.formError = failText(tr("没保存成"), err);
    } finally {
      if (seq === this.seq) {
        this.saving = false;
        this.render();
      }
    }
  }

  private async deleteAccount(id: string): Promise<void> {
    const seq = this.seq;
    try {
      await api.mailDeleteAccount(id);
      if (seq !== this.seq) return;
      this.notice = tr("账号已删除");
      if (this.form?.id === id) this.form = null;
      await this.reload();
    } catch (err) {
      if (seq !== this.seq) return;
      this.formError = failText(tr("没删掉"), err);
      this.render();
    }
  }

  private async testAccount(id: string): Promise<void> {
    this.testing = id;
    this.render();
    const seq = this.seq;
    try {
      const res = await api.mailTestAccount(id);
      if (seq !== this.seq) return;
      this.notice = res.ok ? tr("连上了：IMAP 和 SMTP 都通") : tr("连接有问题，看账号下面的提示");
      await this.reload();
    } catch (err) {
      if (seq !== this.seq) return;
      this.notice = failText(tr("验证失败"), err);
    } finally {
      if (seq === this.seq) {
        this.testing = "";
        this.render();
      }
    }
  }

  private async savePolicy(patch: Partial<MailPolicyView>): Promise<void> {
    const seq = this.seq;
    try {
      const { policy } = await api.mailSavePolicy(patch);
      if (seq !== this.seq || !this.config) return;
      this.config.policy = policy;
      this.render();
    } catch (err) {
      if (seq !== this.seq) return;
      this.notice = failText(tr("权限没保存"), err);
      this.render();
    }
  }
}
