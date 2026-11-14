/**
 * 邮箱面板：顶栏「📮 邮箱」打开的那扇 dialog。
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

type Tab = "inbox" | "settings";

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

export class MailPanel {
  private readonly host: MailHost;
  private root: HTMLElement | null = null;
  private lastFocus: HTMLElement | null = null;
  private esc: ((ev: KeyboardEvent) => void) | null = null;
  private seq = 0;

  private config: MailConfigView | null = null;
  private loadError = "";

  private tab: Tab = "inbox";
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
    this.tab = "inbox";
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
        // 一个账号都没有：直接摊开设置页的新增表单，别让人先找按钮。
        this.tab = "settings";
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
    this.render();
    window.setTimeout(() => {
      const box = this.root?.querySelector<HTMLTextAreaElement>(".mc-compose__text");
      box?.focus();
    }, 0);
  }

  private startNewMail(): void {
    this.compose = { replyToUid: -1, to: "", cc: "", subject: "", text: "", draft: false, busy: false, error: "" };
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
      void this.loadMessages(this.seq);
    } catch (err) {
      if (seq !== this.seq) return;
      box.busy = false;
      box.error = failText(draft ? tr("没存进草稿箱") : tr("没发出去"), err);
      this.render();
    }
  }

  /** 一行性的结果提示，重画后两秒自己消失。 */
  private notice = "";

  private askAi(what: "analyze" | "reply"): void {
    const m = this.detail;
    const account = this.activeAccount();
    if (!m || !account) return;
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

  // -------------------------------------------------------------- 画

  private render(): void {
    const back = el("div", "mc-back");
    back.addEventListener("mousedown", (ev) => {
      if (ev.target === back) this.close();
    });
    const shell = el("section", "mc-console");
    shell.setAttribute("role", "dialog");
    shell.setAttribute("aria-modal", "true");
    shell.setAttribute("aria-label", tr("邮箱"));

    const head = el("header", "mc-head");
    head.append(el("div", "mc-eyebrow", tr("邮箱")));
    head.append(el("h2", "mc-title", tr("我的邮箱")));
    const sub = el("div", "mc-sub", this.config ? this.headSub() : tr("正在读设置…"));
    head.append(sub);
    const headRight = el("div", "mc-head__right");
    if (this.config) {
      for (const [id, label] of [
        ["inbox", tr("邮件")],
        ["settings", tr("设置")],
      ] as [Tab, string][]) {
        const btn = el("button", this.tab === id ? "mc-tab is-on" : "mc-tab", label) as HTMLButtonElement;
        btn.type = "button";
        btn.onclick = () => {
          this.tab = id;
          this.render();
          if (id === "inbox" && !this.messages.length && this.folders.length === 0) void this.loadFolders(this.seq);
        };
        headRight.append(btn);
      }
    }
    const close = el("button", "mc-x", "×") as HTMLButtonElement;
    close.type = "button";
    close.title = tr("关闭");
    close.setAttribute("aria-label", tr("关闭"));
    close.onclick = () => this.close();
    headRight.append(close);
    head.append(headRight);
    shell.append(head);

    if (this.notice) shell.append(el("div", "mc-notice", this.notice));

    const body = el("div", "mc-body");
    if (!this.config && this.loadError) {
      const box = el("div", "mc-empty");
      box.append(el("p", "", this.loadError));
      const retry = el("button", "mc-btn", tr("重试")) as HTMLButtonElement;
      retry.type = "button";
      retry.onclick = () => {
        this.loadError = "";
        this.render();
        void this.reload();
      };
      box.append(retry);
      body.append(box);
    } else if (!this.config) {
      body.append(el("div", "mc-empty", tr("正在读设置…")));
    } else if (this.tab === "settings") {
      body.append(this.settingsEl());
    } else {
      body.append(this.inboxEl());
    }
    shell.append(body);
    back.append(shell);
    this.root?.remove();
    this.root = back;
    document.body.append(back);
  }

  private headSub(): string {
    const accounts = this.config?.accounts ?? [];
    const me = this.activeAccount();
    if (!accounts.length) return tr("还没有账号 —— 先加一个");
    const policy = this.config?.policy;
    const bits: string[] = [];
    if (me) bits.push(me.address + (me.verifiedAt ? "" : tr("（未验证）")));
    if (policy) {
      if (!policy.send) bits.push(tr("AI 只能读"));
      else bits.push(policy.confirmSend ? tr("AI 发信前会问你") : tr("AI 可以直接发"));
    }
    return bits.join(" · ");
  }

  private inboxEl(): HTMLElement {
    const wrap = el("div", "mc-inbox");
    const left = el("aside", "mc-left");
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
      left.append(pick);
    }

    const folderBox = el("div", "mc-folders");
    for (const f of this.folders) {
      const row = el("button", f.path === this.folder ? "mc-folder is-on" : "mc-folder") as HTMLButtonElement;
      row.type = "button";
      row.append(el("span", "mc-folder__name", f.name));
      if (f.kind === "inbox") row.append(el("span", "mc-folder__kind", tr("收件箱")));
      row.onclick = () => {
        if (f.path === this.folder) return;
        this.folder = f.path;
        this.detail = null;
        this.detailUid = -1;
        this.compose = null;
        this.messages = [];
        void this.loadMessages(this.seq);
      };
      folderBox.append(row);
    }
    if (!this.folders.length && !this.listError) folderBox.append(el("div", "mc-hint", tr("正在读邮件夹…")));
    left.append(folderBox);

    const tools = el("div", "mc-listtools");
    const unread = el("label", "mc-check");
    const cb = el("input") as HTMLInputElement;
    cb.type = "checkbox";
    cb.checked = this.unreadOnly;
    cb.onchange = () => {
      this.unreadOnly = cb.checked;
      void this.loadMessages(this.seq);
    };
    unread.append(cb, el("span", "", tr("只看未读")));
    tools.append(unread);
    const refresh = el("button", "mc-mini", tr("刷新")) as HTMLButtonElement;
    refresh.type = "button";
    refresh.onclick = () => void this.loadMessages(this.seq);
    tools.append(refresh);
    const write = el("button", "mc-mini mc-mini--primary", tr("写邮件")) as HTMLButtonElement;
    write.type = "button";
    write.onclick = () => this.startNewMail();
    tools.append(write);
    left.append(tools);

    const list = el("div", "mc-list");
    if (this.listError) list.append(el("div", "mc-hint mc-hint--bad", this.listError));
    else if (this.listLoading && !this.messages.length) list.append(el("div", "mc-hint", tr("正在读邮件…")));
    else if (this.messages.length === 0) list.append(el("div", "mc-hint", this.unreadOnly ? tr("没有未读邮件") : tr("这个文件夹是空的")));
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
    left.append(list);

    const right = el("div", "mc-right");
    if (this.compose) right.append(this.composeEl());
    else if (this.detailLoading) right.append(el("div", "mc-empty", tr("正在读这封信…")));
    else if (this.detailError) right.append(el("div", "mc-empty mc-empty--bad", this.detailError));
    else if (this.detail) right.append(this.detailEl(this.detail));
    else right.append(el("div", "mc-empty", tr("选一封邮件读，或者写一封新的")));
    wrap.append(left, right);
    return wrap;
  }

  private detailEl(m: MailDetailView): HTMLElement {
    const box = el("article", "mc-read");
    box.append(el("h3", "mc-read__subject", m.subject || tr("（无主题）")));
    const meta = el("div", "mc-read__meta");
    meta.append(el("span", "", tr("发件人：{v}", { v: m.from })));
    if (m.to.length) meta.append(el("span", "", tr("收件人：{v}", { v: m.to.join(", ") })));
    if (m.cc.length) meta.append(el("span", "", tr("抄送：{v}", { v: m.cc.join(", ") })));
    meta.append(el("span", "", whenText(m.date)));
    box.append(meta);

    const acts = el("div", "mc-read__acts");
    const reply = el("button", "mc-btn", tr("回复")) as HTMLButtonElement;
    reply.type = "button";
    reply.onclick = () => this.startReply("reply");
    const draft = el("button", "mc-btn", tr("写草稿")) as HTMLButtonElement;
    draft.type = "button";
    draft.onclick = () => this.startReply("draft");
    const analyze = el("button", "mc-btn", tr("让 AI 分析")) as HTMLButtonElement;
    analyze.type = "button";
    analyze.onclick = () => this.askAi("analyze");
    const aiReply = el("button", "mc-btn", tr("让 AI 起草回复")) as HTMLButtonElement;
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

    box.append(el("pre", "mc-read__text", m.text || tr("（没有纯文本正文）")));
    return box;
  }

  private composeEl(): HTMLElement {
    const c = this.compose!;
    const box = el("form", "mc-compose");
    box.addEventListener("submit", (ev) => ev.preventDefault());
    box.append(el("h3", "mc-read__subject", c.replyToUid >= 0 ? tr("回复") : tr("新邮件")));

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
    box.append(field(tr("收件人"), c.to, "to"), field(tr("抄送"), c.cc, "cc"), field(tr("主题"), c.subject, "subject"));

    const ta = el("textarea", "mc-compose__text") as HTMLTextAreaElement;
    ta.value = c.text;
    ta.rows = 12;
    ta.setAttribute("aria-label", tr("正文"));
    ta.oninput = () => {
      c.text = ta.value;
    };
    box.append(ta);
    if (c.error) box.append(el("div", "mc-hint mc-hint--bad", c.error));

    const acts = el("div", "mc-read__acts");
    const send = el("button", "mc-btn mc-btn--primary", c.busy ? tr("发送中…") : tr("发送")) as HTMLButtonElement;
    send.type = "button";
    send.disabled = c.busy;
    send.onclick = () => void this.sendCompose(false);
    const save = el("button", "mc-btn", tr("存草稿")) as HTMLButtonElement;
    save.type = "button";
    save.disabled = c.busy;
    save.onclick = () => void this.sendCompose(true);
    const cancel = el("button", "mc-btn", tr("取消")) as HTMLButtonElement;
    cancel.type = "button";
    cancel.onclick = () => {
      this.compose = null;
      this.render();
    };
    acts.append(send, save, cancel);
    box.append(acts);
    return box;
  }

  private settingsEl(): HTMLElement {
    const wrap = el("div", "mc-settings");
    const cfg = this.config!;

    // ---------------------------------------------------------- 账号
    const accBox = el("section", "mc-card");
    accBox.append(el("h3", "mc-card__title", tr("账号")));
    if (!cfg.accounts.length) accBox.append(el("div", "mc-hint", tr("加一个邮箱账号，AI 才有邮可读")));
    for (const a of cfg.accounts) {
      const row = el("div", "mc-acct");
      const info = el("div", "mc-acct__info");
      info.append(el("div", "mc-acct__addr", a.address));
      const line = el("div", "mc-acct__meta");
      const badge = a.verifiedAt
        ? el("span", "mc-badge mc-badge--ok", tr("已验证"))
        : el("span", "mc-badge", a.lastError ? tr("连接失败") : tr("未验证"));
      line.append(badge, el("span", "", a.label));
      line.append(el("span", "", `${a.imap.host}:${a.imap.port} / ${a.smtp.host}:${a.smtp.port}`));
      if (a.lastError) line.append(el("span", "mc-acct__err", a.lastError));
      info.append(line);
      row.append(info);

      const acts = el("div", "mc-acct__acts");
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
      };
      const del = el("button", "mc-mini mc-mini--bad", tr("删")) as HTMLButtonElement;
      del.type = "button";
      del.onclick = () => void this.deleteAccount(a.id);
      acts.append(test, edit, del);
      row.append(acts);
      accBox.append(row);
    }
    if (!this.form) {
      const add = el("button", "mc-btn", tr("添加账号")) as HTMLButtonElement;
      add.type = "button";
      add.onclick = () => {
        this.form = emptyForm(cfg.presetIds[0] ?? "163", ...this.presetEndpoints(cfg, cfg.presetIds[0] ?? "163"));
        this.formError = "";
        this.render();
      };
      accBox.append(add);
    }
    wrap.append(accBox);

    if (this.form) wrap.append(this.formEl(this.form));

    // ---------------------------------------------------------- 权限
    const policy = el("section", "mc-card");
    policy.append(el("h3", "mc-card__title", tr("AI 能做什么")));
    for (const item of MAIL_POLICY_LABELS) {
      const row = el("label", "mc-check mc-check--block");
      const cb = el("input") as HTMLInputElement;
      cb.type = "checkbox";
      cb.checked = Boolean(cfg.policy[item.key]);
      cb.onchange = () => void this.savePolicy({ [item.key]: cb.checked } as Partial<MailPolicyView>);
      const text = el("span", "mc-check__body");
      text.append(el("span", "mc-check__label", tr(item.label)));
      text.append(el("span", "mc-check__hint", tr(item.hint)));
      row.append(cb, text);
      policy.append(row);
    }

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
    policy.append(limitRow);
    policy.append(el("div", "mc-hint", tr("0 表示不限；只算 AI 发的，你自己点的不算")));

    const rcptRow = el("label", "mc-field");
    rcptRow.append(el("span", "mc-field__label", tr("只允许发给（一行一个，留空=谁都能发）")));
    const rcpt = el("textarea", "mc-input") as HTMLTextAreaElement;
    rcpt.rows = 3;
    rcpt.value = cfg.policy.recipients.join("\n");
    rcpt.onchange = () =>
      void this.savePolicy({ recipients: parseRecipients(rcpt.value) });
    rcptRow.append(rcpt);
    policy.append(rcptRow);

    if (cfg.accounts.length > 1) {
      const accRow = el("div", "mc-field");
      accRow.append(el("span", "mc-field__label", tr("AI 能用哪些账号（都不勾 = 全部）")));
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
        accRow.append(label);
      }
      policy.append(accRow);
    }
    wrap.append(policy);

    // ---------------------------------------------------------- 审计
    const audit = el("section", "mc-card");
    audit.append(el("h3", "mc-card__title", tr("最近发出去的")));
    if (!cfg.audit.length) audit.append(el("div", "mc-hint", tr("还没有记录")));
    for (const row of cfg.audit) {
      const line = el("div", row.ok ? "mc-audit" : "mc-audit mc-audit--bad");
      line.append(el("span", "mc-audit__when", whenText(row.t)));
      line.append(el("span", "mc-audit__to", (row.to ?? []).join(", ")));
      line.append(el("span", "mc-audit__subj", row.subject));
      line.append(el("span", "mc-audit__by", row.by === "agent" ? tr("AI") : tr("我")));
      if (!row.ok) line.append(el("span", "mc-audit__err", row.error ?? tr("失败")));
      audit.append(line);
    }
    wrap.append(audit);
    return wrap;
  }

  private formEl(f: AccountForm): HTMLElement {
    const cfg = this.config!;
    const box = el("section", "mc-card mc-card--form");
    box.append(el("h3", "mc-card__title", f.id ? tr("改账号") : tr("新账号")));

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

    box.append(input(tr("邮箱地址"), f.address, "email", (v) => (f.address = v)));
    box.append(input(tr("显示名"), f.label, "text", (v) => (f.label = v)));

    const presetRow = el("label", "mc-field");
    presetRow.append(el("span", "mc-field__label", tr("邮箱类型")));
    const pick = el("select", "mc-select") as HTMLSelectElement;
    for (const id of cfg.presetIds) {
      const opt = el("option", "", cfg.presets[id]?.label ?? id) as HTMLOptionElement;
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
    };
    presetRow.append(pick);
    box.append(presetRow);

    box.append(
      input(tr("登录账号（多数就是地址全称）"), f.user, "text", (v) => (f.user = v)),
      input(tr("客户端授权码"), f.secret, "password", (v) => (f.secret = v)),
    );
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
      box.append(input(tr("IMAP 服务器"), f.imapHost, "text", (v) => (f.imapHost = v)));
      box.append(input(tr("IMAP 端口"), f.imapPort, "number", (v) => (f.imapPort = v)));
      box.append(input(tr("SMTP 服务器"), f.smtpHost, "text", (v) => (f.smtpHost = v)));
      box.append(input(tr("SMTP 端口"), f.smtpPort, "number", (v) => (f.smtpPort = v)));
    }

    if (this.formError) box.append(el("div", "mc-hint mc-hint--bad", this.formError));
    const acts = el("div", "mc-read__acts");
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

  private focusFirst(): void {
    window.setTimeout(() => {
      this.root?.querySelector<HTMLInputElement>(".mc-card--form .mc-input")?.focus();
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
      smtp: { host: f.smtpHost.trim(), port: Number(f.smtpPort) || 465, secure: true },
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
