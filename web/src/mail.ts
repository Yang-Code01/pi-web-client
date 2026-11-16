/**
 * 邮箱面板：顶栏「📮 邮箱」打开的那扇控制台。
 *
 * 版式照「设置 → 本机管理」：中间一块 1120×800 的对话框，左边分区导航（邮件 / 写邮件 /
 * 账号 / AI 权限 / 发送与草稿），右边是当前分区；顶栏放账号与策略摘要，底栏一句口径。
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
import { mountOverlay, trapEscape } from "./modal.ts";
import "./mail-console.css";
import { errText, tr } from "./i18n/index.ts";
import type {
  MailAccountInput,
  MailAccountView,
  MailAuth,
  MailConfigView,
  MailDetailView,
  MailEndpoint,
  MailFolderView,
  MailOAuthLoginView,
  MailPolicyView,
  MailSummary,
} from "./mail-shared.ts";
import { buildMailFrameHtml, renderMailHtml } from "./mailhtml.ts";
import { joinAddress, localPartFor, presetAuths, presetDomain, retargetAddress, splitAddress } from "./mail-shared.ts";
import { auditOutcome, MAIL_POLICY_LABELS, mailErrorText, parseRecipients, portOf, secureForPort, sizeText, whenText } from "./mail-shared.ts";

export interface MailHandoff {
  prefill(text: string): void;
  newSessionWith(text: string): void;
}

export interface MailHost {
  handoff: MailHandoff;
}

type Section = "inbox" | "compose" | "accounts" | "policy" | "audit";

/**
 * 邮件夹的显示名：收件箱/已发送/草稿箱/已删除/垃圾邮件按 `kind` 本地化，其余（自定义目录、
 * 服务器自己的别名）原样显示。IMAP 回的是 `INBOX` / `Sent Messages` 这种协议名，直接铺在
 * 中文界面里就是中英混杂；英文界面下这里照样落到英文词，因为译法本来就在 en.ts。
 */
function folderLabel(f: MailFolderView): string {
  switch (f.kind) {
    case "inbox":
      return tr("收件箱");
    case "sent":
      return tr("已发送");
    case "drafts":
      return tr("草稿箱");
    case "trash":
      return tr("已删除");
    case "junk":
      return tr("垃圾邮件");
    default:
      return f.name;
  }
}

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
  /** `oauth` 的账号不填授权码，改用 Entra 应用 + 设备码登录。 */
  auth: MailAuth;
  oauthClientId: string;
  oauthTenant: string;
  imapHost: string;
  imapPort: string;
  smtpHost: string;
  smtpPort: string;
  advanced: boolean;
}

function emptyForm(preset: string, imap: MailEndpoint, smtp: MailEndpoint, auth: MailAuth = "password"): AccountForm {
  return {
    label: "",
    address: "",
    preset,
    user: "",
    secret: "",
    auth,
    oauthClientId: "",
    oauthTenant: "",
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
    auth: account.auth === "oauth" ? "oauth" : "password",
    oauthClientId: account.oauthClientId,
    oauthTenant: account.oauthTenant,
    imapHost: account.imap.host,
    imapPort: String(account.imap.port),
    smtpHost: account.smtp.host,
    smtpPort: String(account.smtp.port),
    advanced: false,
  };
}

type AutoComplete = "off" | "on" | "name" | "email" | "username" | "new-password";

function textInput(value: string, type = "text", autocomplete?: AutoComplete): HTMLInputElement {
  const inp = el("input", "mc-input") as HTMLInputElement;
  inp.type = type;
  inp.value = value;
  // Chrome / Edge 对密码框无视 "off"，会把浏览器存的本站登录密码自动填进来，
  // 看着像「授权码已经填好了」。密码框统一走 "new-password"（和 Jira 的 API token 同一口径）。
  // 其他字段只在语义明确时给 autocomplete，别一刀切 "off"。
  if (autocomplete) inp.autocomplete = autocomplete;
  inp.spellcheck = false;
  return inp;
}

function fieldRow(label: string, content: HTMLElement): HTMLElement {
  const row = el("label", "mc-field");
  row.append(el("span", "mc-field__label", label), content);
  return row;
}

function formInput(
  label: string,
  value: string,
  type = "text",
  oninput?: (v: string) => void,
  autocomplete?: AutoComplete,
): HTMLElement {
  const inp = textInput(value, type, autocomplete);
  inp.oninput = () => oninput?.(inp.value);
  return fieldRow(label, inp);
}

/** 「哪一步没成」+ 桥的错误：`errText` 只认一个参数，语境在自己这层加。 */
function failText(what: string, err: unknown): string {
  return tr("{what}：{why}", { what, why: errText(err) });
}

/** 列表一页多少封（底部「看更早的」按这个往后翻）。 */
const LIST_PAGE = 30;

/** 邮件正文 iframe 的高度：先占位，load 后按内容量，超过上限才让它自己滚。 */
const MAIL_FRAME_MIN_HEIGHT = 160;
const MAIL_FRAME_MAX_HEIGHT = 20000;
const MAIL_FRAME_SETTLE_MS = [120, 600];

/** 审计行里的失败：桥给的是稳定错误码，翻成人话再显示（认不出来的只说「失败」，不露原文）。 */
function auditFailText(code: string | undefined): string {
  const hit = mailErrorText(code);
  return hit ? tr(hit) : tr("失败");
}

const SECTIONS: { id: Section; label: string }[] = [
  { id: "inbox", label: "邮件" },
  { id: "compose", label: "写邮件" },
  { id: "accounts", label: "账号" },
  { id: "policy", label: "AI 权限" },
  // 跟分区标题一致：这一页记的是发送与存草稿，不只“记录发送”。
  { id: "audit", label: "发送与草稿" },
];

export class MailPanel {
  private readonly host: MailHost;
  private root: HTMLElement | null = null;
  private lastFocus: HTMLElement | null = null;
  private untrap: (() => void) | null = null;
  /** 面板「代」：只在开/关时 +1，用来判断整个面板是不是已经换了。
   *  刷新不能动它，否则保存/验证这种「等请求回来再改 saving/testing」的操作会被自己的 reload 判过期。 */
  private seq = 0;
  /** 刷新请求自己的代号：只用来丢掉旧的 reload，不影响保存/验证。 */
  private reloadSeq = 0;
  /** 列表与详情各自的请求代号：切文件夹/账号、重新取数时 +1，回来对不上就丢掉。
   *  以前两处都比 `seq`，而切文件夹并不动 `seq`，于是先点的慢响应会盖掉后点的（选中的是 B、列表是 A）。 */
  private listSeq = 0;
  private detailSeq = 0;

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
  /** 最后一页是不是取满了：取满就说明后面可能还有，底部给一个「看更早的」。 */
  private listHasMore = false;
  /** 左栏邮件列表是否折叠；折叠后右栏占满整行，读 HTML 邮件时不再被窄列表挤着。 */
  private listCollapsed = false;

  private detail: MailDetailView | null = null;
  private detailUid = -1;
  private detailLoading = false;
  private detailError = "";
  /** 当前正文 iframe：折叠列表后只要重算这一只，不去 DOM 里按类名摸。 */
  private detailFrame: HTMLIFrameElement | null = null;
  /** 哪封信放行过远程图片（按 uid）；换一封信自然失效，关面板时清掉。 */
  private remoteImagesUid = -1;

  private compose: Compose | null = null;
  private form: AccountForm | null = null;
  private saving = false;
  private formError = "";
  private testing = "";
  /** 正在等用户去 Microsoft 页面上输码的设备码登录（一次只允许一个）。 */
  private oauth: { accountId: string; login: MailOAuthLoginView } | null = null;
  /** 正在对哪个账号发登录/退出请求（按钮转圈）。 */
  private oauthBusy = "";
  private oauthError = "";
  private oauthTimer = 0;
  /** 「删」的第一下：等第二下才算数（空串 = 没有待确认的）。 */
  private confirmDeleteId = "";
  private deleteTimer = 0;

  constructor(host: MailHost) {
    this.host = host;
  }

  open(): void {
    if (this.root) this.close();
    this.seq += 1;
    this.reloadSeq += 1;
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
    this.listHasMore = false;
    this.listCollapsed = false;
    this.listSeq += 1;
    this.detailSeq += 1;
    this.detail = null;
    this.detailUid = -1;
    this.detailLoading = false;
    this.detailError = "";
    this.detailFrame = null;
    this.remoteImagesUid = -1;
    this.compose = null;
    this.form = null;
    this.saving = false;
    this.formError = "";
    this.testing = "";
    this.oauth = null;
    this.oauthBusy = "";
    this.oauthError = "";
    if (this.oauthTimer) window.clearTimeout(this.oauthTimer);
    this.oauthTimer = 0;
    this.confirmDeleteId = "";
    this.lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.untrap = trapEscape(() => this.close());
    this.render();
    void this.reload();
  }

  close(): void {
    this.untrap?.();
    this.untrap = null;
    this.seq += 1;
    this.reloadSeq += 1;
    this.listSeq += 1;
    this.detailSeq += 1;
    this.detailFrame = null;
    this.remoteImagesUid = -1;
    this.confirmDeleteId = "";
    if (this.deleteTimer) window.clearTimeout(this.deleteTimer);
    this.deleteTimer = 0;
    // 关面板就当取消这次设备码登录：留着只会让桥那边多一条不会被用的轮询状态。
    if (this.oauthTimer) window.clearTimeout(this.oauthTimer);
    this.oauthTimer = 0;
    if (this.oauth) void api.mailOAuthCancel(this.oauth.accountId).catch(() => {});
    this.oauth = null;
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
    const seq = this.seq;
    const load = ++this.reloadSeq;
    try {
      const config = await api.mailConfig();
      if (seq !== this.seq || load !== this.reloadSeq || !this.root) return;
      this.config = config;
      this.loadError = "";
      if (!config.accounts.length) {
        // 一个账号都没有：直接摊开账号页的新增表单，别让人先找按钮。
        this.section = "accounts";
        const preset = config.presetIds[0] ?? "163";
        this.form = emptyForm(preset, ...this.presetEndpoints(config, preset), this.defaultAuth(config, preset));
        this.render();
        this.focusFirst();
        return;
      }
      this.render();
      await this.loadFolders(seq, load);
    } catch (err) {
      if (seq !== this.seq || load !== this.reloadSeq) return;
      this.loadError = failText(tr("打不开邮箱设置"), err);
      this.render();
    }
  }

  private presetEndpoints(config: MailConfigView, preset: string): [MailEndpoint, MailEndpoint] {
    const p = config.presets[preset];
    const fallback: MailEndpoint = { host: "", port: 993, secure: true };
    return [p?.imap ?? fallback, p?.smtp ?? { host: "", port: 465, secure: true }];
  }

  /**
   * 预设名是桥给的中文原文（`PRESETS[id].label`），直接用只有中文。需要翻译的在这里列一项，
   * 其余照旧显示桥给的名字：`tr()` 找不到键就把键原样吐回来，所以不列也不会变成空字符串。
   */
  private presetLabel(id: string, label: string): string {
    if (id === "m365") return tr("Microsoft 365（公司/学校）");
    return label;
  }

  /** 新表单的默认认证方式：预设列表的第一个（Outlook / Microsoft 365 只有 oauth）。 */
  private defaultAuth(config: MailConfigView, preset: string): MailAuth {
    return presetAuths(config.presets, preset)[0] ?? "password";
  }

  private async loadFolders(seq: number, load = this.reloadSeq): Promise<void> {
    const account = this.activeAccount();
    if (!account) return;
    try {
      const { folders } = await api.mailFolders(account.id);
      if (seq !== this.seq || load !== this.reloadSeq || !this.root) return;
      this.folders = folders;
      const known = folders.some((f) => f.path === this.folder);
      if (!known) this.folder = folders.find((f) => f.kind === "inbox")?.path ?? folders[0]?.path ?? "INBOX";
      await this.loadMessages(seq, false, load);
    } catch (err) {
      if (seq !== this.seq || load !== this.reloadSeq) return;
      this.listError = failText(tr("拿不到邮件夹"), err);
      this.render();
    }
  }

  private async loadMessages(seq: number, append = false, load = this.reloadSeq): Promise<void> {
    const account = this.activeAccount();
    if (!account) return;
    const token = ++this.listSeq;
    const folder = this.folder;
    this.listLoading = true;
    this.render();
    try {
      const { messages } = await api.mailMessages({
        account: account.id,
        folder,
        limit: LIST_PAGE,
        offset: append ? this.messages.length : 0,
        unread: this.unreadOnly,
      });
      // 过期判定两道：面板还在（seq） + 没有更新的请求（listSeq）。
      if (seq !== this.seq || token !== this.listSeq || load !== this.reloadSeq || !this.root) return;
      const merged = append ? [...this.messages, ...messages.filter((m) => !this.messages.some((old) => old.uid === m.uid))] : messages;
      this.messages = merged;
      this.listHasMore = messages.length >= LIST_PAGE;
      this.listError = "";
    } catch (err) {
      if (seq !== this.seq || token !== this.listSeq || load !== this.reloadSeq) return;
      if (!append) this.messages = [];
      this.listError = failText(tr("邮件列表拿不到"), err);
    } finally {
      if (seq === this.seq && token === this.listSeq && load === this.reloadSeq) {
        this.listLoading = false;
        this.render();
      }
    }
  }

  private async openMessage(uid: number): Promise<void> {
    const account = this.activeAccount();
    if (!account) return;
    const seq = this.seq;
    const token = ++this.detailSeq;
    const folder = this.folder;
    this.detailUid = uid;
    this.detailLoading = true;
    this.detailError = "";
    this.compose = null;
    this.render();
    try {
      const res = await api.mailMessage({ account: account.id, folder, uid });
      if (seq !== this.seq || token !== this.detailSeq || !this.root) return;
      this.detail = res.message;
      // 这里**不**把本地那条标成已读（以前会）：读信用 PEEK，服务器上的 \Seen 根本没动，
      // 改本地列表只是骗人 —— 刷一下又变回未读，人却以为自己处理过了。
    } catch (err) {
      if (seq !== this.seq || token !== this.detailSeq) return;
      this.detail = null;
      this.detailError = failText(tr("这封信读不出来"), err);
    } finally {
      // 代号也要比：先发的慢详情回来不能把后发请求的「正在读」提前收掉（内容不盖、状态会错）。
      if (seq === this.seq && token === this.detailSeq) {
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
    mountOverlay(back);
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
    if (this.config?.configError)
      box.append(
        el(
          "div",
          "mc-banner mc-banner--bad",
          tr("配置文件读不出来（{why}），账号列表是空的。为了不覆盖掉里面的账号和授权码，保存和改设置都停了：修好或删掉 {path} 再刷新。", {
            why: this.config.configError,
            path: this.config.configPath ?? "mail/config.json",
          }),
        ),
      );
    if (this.notice) box.append(el("div", "mc-banner mc-banner--ok", this.notice));
    return box;
  }

  private mainEl(): HTMLElement {
    const main = el("div", "mc-main");
    const nav = el("nav", "mc-nav");
    nav.setAttribute("aria-label", tr("邮箱分区"));
    const counts: Partial<Record<Section, number>> = {
      accounts: this.config?.accounts.length ?? 0,
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
    const split = el("div", "mc-split");
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
        this.listHasMore = false;
        this.listSeq += 1;
        this.detailSeq += 1;
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
      chip.append(el("span", "", folderLabel(f)));
      chip.onclick = () => {
        if (f.path === this.folder) return;
        this.folder = f.path;
        this.detail = null;
        this.detailUid = -1;
        this.compose = null;
        this.messages = [];
        this.listHasMore = false;
        // 切文件夹要作废在飞的请求：以前不比代号，慢的那个回来会盖掉新文件夹的列表。
        this.listSeq += 1;
        this.detailSeq += 1;
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

    const toggleList = el("button", "mc-mini") as HTMLButtonElement;
    toggleList.type = "button";
    toggleList.setAttribute("aria-controls", "mc-mail-list");
    const paintListToggle = () => {
      toggleList.textContent = this.listCollapsed ? tr("展开列表") : tr("折叠列表");
      toggleList.setAttribute("aria-pressed", String(this.listCollapsed));
      toggleList.title = this.listCollapsed ? tr("展开邮件列表") : tr("折叠邮件列表，让正文更宽");
      split.classList.toggle("is-list-collapsed", this.listCollapsed);
    };
    paintListToggle();
    toggleList.onclick = () => {
      this.listCollapsed = !this.listCollapsed;
      paintListToggle();
      // 右栏变宽后正文会重新排版，iframe 高度跟着重算（复用同一组 settle 时序）。
      for (const ms of [0, ...MAIL_FRAME_SETTLE_MS]) window.setTimeout(() => this.refitMailFrame(), ms);
    };

    const refresh = el("button", "mc-mini", tr("刷新")) as HTMLButtonElement;
    refresh.type = "button";
    refresh.onclick = () => void this.loadMessages(this.seq);
    const write = el("button", "mc-mini mc-mini--primary", tr("写邮件")) as HTMLButtonElement;
    write.type = "button";
    write.onclick = () => this.startNewMail();
    bar.append(toggleList, refresh, write);

    split.append(this.listEl(), this.readEl());
    wrap.append(bar, split);
    return wrap;
  }

  private listEl(): HTMLElement {
    const list = el("div", "mc-list");
    list.id = "mc-mail-list";
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
      // 一页取满就说明后面可能还有：邮箱不只这几十封，以前这里没有任何出口（D264）。
      if (this.listHasMore) {
        const more = el("button", "mc-mini mc-more", this.listLoading ? tr("正在读…") : tr("看更早的")) as HTMLButtonElement;
        more.type = "button";
        more.disabled = this.listLoading;
        more.onclick = () => void this.loadMessages(this.seq, true);
        list.append(more);
      } else if (this.messages.length >= LIST_PAGE && !this.listLoading) {
        list.append(el("div", "mc-hint", tr("到这个文件夹的开头了")));
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

    // 「附件」只认真正被标成附件的部分；带 Content-ID 但 disposition=attachment 的图仍是附件。
    const files = m.attachments.filter((a) => !a.inline);
    if (files.length) {
      const att = el("div", "mc-attach");
      // 页面上的附件是**人自己**在下载：不受「取附件」（那是 AI 的开关）管，永远给直链（D264）。
      att.append(el("div", "mc-attach__title", tr("附件")));
      for (const a of files) {
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

    const htmlBody = m.html?.trim() ? this.htmlBodyEl(m) : null;
    if (htmlBody) box.append(htmlBody);
    else box.append(el("pre", "mc-letter__text", m.text || tr("（没有纯文本正文）")));
    return box;
  }

  /**
   * 邮件正文：HTML 放 sandbox iframe（脚本跑不了、样式也漏不出来），内嵌图片直接显示；
   * 远程图片默认收起，点「显示图片」才放行 —— 和邮件客户端一个口径，别一打开信就把
   * 本机 IP 和阅读行为送给发件人的追踪像素。
   */
  private htmlBodyEl(m: MailDetailView): HTMLElement | null {
    const allowRemote = this.remoteImagesUid === m.uid;
    const rendered = renderMailHtml(m.html ?? "", {
      attachments: m.attachments,
      allowRemote,
      inlineUrl: (a) =>
        api.mailAttachmentUrl({
          account: this.activeAccount()?.id,
          folder: this.folder,
          uid: m.uid,
          index: a.index,
          inline: true,
        }),
    });

    // 只有 <style> / 空 body 的信：清理完什么都没有，退回纯文本，别给一块空白。
    if (!rendered.html.trim()) return null;
    const wrap = el("div", "mc-body");
    const remoteCount = rendered.remoteImages || rendered.remoteCss;
    if (remoteCount > 0) {
      const bar = el("div", "mc-body__bar");
      const hint = el(
        "span",
        "mc-body__hint",
        allowRemote ? tr("远程图片已显示") : tr("为保护隐私，远程图片默认不加载"),
      );
      bar.append(hint);
      const label = allowRemote
        ? tr("不显示图片")
        : rendered.remoteImages > 0
          ? tr("显示图片（{n}）", { n: String(rendered.remoteImages) })
          : tr("显示远程图片");
      const toggle = el("button", "mc-mini", label) as HTMLButtonElement;
      toggle.type = "button";
      toggle.onclick = () => {
        this.remoteImagesUid = allowRemote ? -1 : m.uid;
        this.render();
      };
      bar.append(toggle);
      wrap.append(bar);
    }

    const frame = el("iframe", "mc-html") as HTMLIFrameElement;
    frame.setAttribute("sandbox", "allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("title", tr("邮件正文"));
    frame.setAttribute("scrolling", "no");
    frame.style.height = `${MAIL_FRAME_MIN_HEIGHT}px`;
    frame.srcdoc = buildMailFrameHtml(rendered, allowRemote);
    frame.onload = () => this.fitMailFrame(frame);
    this.detailFrame = frame;
    wrap.append(frame);
    // iframe 的内容高度只有在 onload 之后才知道；图片是后加载的，再补两次。
    for (const ms of MAIL_FRAME_SETTLE_MS) window.setTimeout(() => this.fitMailFrame(frame), ms);
    return wrap;
  }

  private refitMailFrame(): void {
    if (this.detailFrame?.isConnected) this.fitMailFrame(this.detailFrame);
  }

  private fitMailFrame(frame: HTMLIFrameElement): void {
    const doc = frame.contentDocument;
    if (!doc?.body) return;
    // 先缩回最小高度再量 body：documentElement.scrollHeight 是 iframe 自己的视口，
    // 拿它会让高度只能变大（折叠后正文变矮也收不回来）。
    frame.style.height = `${MAIL_FRAME_MIN_HEIGHT}px`;
    const contentHeight = Math.max(doc.body.scrollHeight, doc.body.getBoundingClientRect().height, MAIL_FRAME_MIN_HEIGHT);
    const height = Math.min(Math.ceil(contentHeight), MAIL_FRAME_MAX_HEIGHT);
    frame.style.height = `${height}px`;
    frame.setAttribute("scrolling", contentHeight > MAIL_FRAME_MAX_HEIGHT ? "auto" : "no");
    // 图片/字体加载完高度会变；监听这一次，别让正文被截掉半截。
    for (const img of Array.from(doc.images)) {
      if (img.complete) continue;
      img.addEventListener("load", () => this.fitMailFrame(frame), { once: true });
      img.addEventListener("error", () => this.fitMailFrame(frame), { once: true });
    }
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
    head.append(el("div", "mc-section__meta", tr("授权码与登录令牌只存本机；页面只拿掩码")));
    sec.append(head);
    // 登录 / 退出失败时卡片已经收了，错误得留在这页上，否则右上角的转圈一停就什么都没发生。
    if (this.oauthError) sec.append(el("div", "mc-hint mc-hint--bad", this.oauthError));

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
        // OAuth 账号（Outlook / Microsoft 365）没有授权码，「已验证」之外还要看登录过没有。
        if (a.auth === "oauth") {
          status.append(
            a.hasToken
              ? el("span", "mc-tag mc-tag--ok", a.oauthUpn ? tr("已登录 {upn}", { upn: a.oauthUpn }) : tr("已登录"))
              : el("span", "mc-tag", tr("未登录")),
          );
        }
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
        // 微软登录：没登录过的叫「Microsoft 登录」，登录过的叫「重新登录」（换账号 / 重装后令牌失效）。
        if (a.auth === "oauth") {
          const busy = this.oauthBusy === a.id || this.oauth?.accountId === a.id;
          const login = el(
            "button",
            "mc-mini mc-mini--primary",
            busy && this.oauthBusy === a.id
              ? tr("正在要码…")
              : a.hasToken
                ? tr("重新登录")
                : tr("Microsoft 登录"),
          ) as HTMLButtonElement;
          login.type = "button";
          login.disabled = busy;
          login.onclick = () => void this.startOAuth(a.id);
          ops.append(login);
        }
        const del = el("button", this.confirmDeleteId === a.id ? "mc-mini mc-mini--bad on" : "mc-mini mc-mini--bad", this.confirmDeleteId === a.id ? tr("真删？") : tr("删")) as HTMLButtonElement;
        del.type = "button";
        // 一点就没（连同授权码）太狠：第一下只是「真删？」，6 秒内再点才删。
        del.onclick = () => {
          if (this.confirmDeleteId === a.id) {
            this.confirmDeleteId = "";
            if (this.deleteTimer) window.clearTimeout(this.deleteTimer);
            this.deleteTimer = 0;
            void this.deleteAccount(a.id);
            return;
          }
          this.confirmDeleteId = a.id;
          if (this.deleteTimer) window.clearTimeout(this.deleteTimer);
          this.deleteTimer = window.setTimeout(() => {
            this.deleteTimer = 0;
            if (!this.confirmDeleteId) return;
            this.confirmDeleteId = "";
            this.render();
          }, 6000);
          this.render();
        };
        ops.append(test, edit);
        if (a.auth === "oauth" && a.hasToken) {
          const out = el("button", "mc-mini", this.oauthBusy === a.id ? tr("正在退出…") : tr("退出登录")) as HTMLButtonElement;
          out.type = "button";
          out.disabled = this.oauthBusy === a.id;
          out.onclick = () => void this.logoutOAuth(a.id);
          ops.append(out);
        }
        ops.append(del);
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
        const preset = cfg.presetIds[0] ?? "163";
        this.form = emptyForm(preset, ...this.presetEndpoints(cfg, preset), this.defaultAuth(cfg, preset));
        this.formError = "";
        this.render();
        this.focusFirst();
      };
      sec.append(add);
    }
    wrap.append(sec);
    const card = this.oauthCardEl();
    if (card) wrap.append(card);
    if (this.form) wrap.append(this.formEl(this.form));
    return wrap;
  }

  /**
   * 设备码登录那张卡：微软让用户到网页上输一段码，桥按微软给的节奏轮询。
   * 卡只在这次登录进行中才在，取消或成功就消失（不留一个空壳）。
   */
  private oauthCardEl(): HTMLElement | null {
    const pending = this.oauth;
    if (!pending) return null;
    const account = this.config?.accounts.find((a) => a.id === pending.accountId);
    const sec = el("section", "mc-section mc-oauth");
    const head = el("div", "mc-section__head");
    head.append(el("div", "mc-section__label", tr("用 Microsoft 登录")));
    head.append(el("div", "mc-section__meta", account ? account.address : ""));
    sec.append(head);

    const steps = el("ol", "mc-oauth__steps");
    const openStep = el("li", "");
    openStep.append(el("span", "", tr("在浏览器里打开：")));
    const link = el("a", "mc-oauth__link", pending.login.verificationUri) as HTMLAnchorElement;
    link.href = pending.login.verificationUri;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    openStep.append(link, el("span", "", tr("（手机也能开）")));
    const codeStep = el("li", "");
    codeStep.append(el("span", "", tr("输入这个码：")));
    codeStep.append(el("code", "mc-oauth__code", pending.login.userCode));
    const signInStep = el("li", "", tr("用要加进来的那个邮箱账号登录并同意。这一步完成以后下面会自动消失。"));
    steps.append(openStep, codeStep, signInStep);
    sec.append(steps);

    const mins = Math.max(1, Math.round((pending.login.expiresAt - Date.now()) / 60000));
    sec.append(el("div", "mc-hint", tr("这个码 {mins} 分钟内有效；关掉面板或点取消就等于这次不登了。", { mins })));

    const acts = el("div", "mc-acts");
    const cancel = el("button", "mc-btn", tr("取消登录")) as HTMLButtonElement;
    cancel.type = "button";
    cancel.onclick = () => this.cancelOAuth(pending.accountId);
    acts.append(cancel);
    sec.append(acts);
    return sec;
  }

  // -------------------------------------------------------------- Microsoft 登录

  private async startOAuth(accountId: string): Promise<void> {
    if (this.oauthBusy) return;
    this.oauthBusy = accountId;
    this.oauthError = "";
    this.render();
    const seq = this.seq;
    try {
      const { login } = await api.mailOAuthStart(accountId);
      if (seq !== this.seq) return;
      this.oauth = { accountId, login };
      this.scheduleOAuthPoll(seq, accountId, Math.max(0, (login.nextPollAt || 0) - Date.now()));
    } catch (err) {
      if (seq !== this.seq) return;
      this.oauthError = failText(tr("没拿到登录码"), err);
    } finally {
      if (seq === this.seq) {
        this.oauthBusy = "";
        this.render();
      }
    }
  }

  /** 按桥给的节奏问一次；微软对间隔敏感，问快了码会作废（slow_down）。 */
  private scheduleOAuthPoll(seq: number, accountId: string, waitMs: number): void {
    if (this.oauthTimer) window.clearTimeout(this.oauthTimer);
    this.oauthTimer = window.setTimeout(() => void this.pollOAuth(seq, accountId), Math.max(0, waitMs));
  }

  private async pollOAuth(seq: number, accountId: string): Promise<void> {
    this.oauthTimer = 0;
    if (seq !== this.seq || this.oauth?.accountId !== accountId || !this.root) return;
    try {
      const res = await api.mailOAuthPoll(accountId);
      if (seq !== this.seq || this.oauth?.accountId !== accountId) return;
      if (res.status === "pending") {
        this.scheduleOAuthPoll(seq, accountId, res.waitMs);
        return;
      }
      this.oauth = null;
      if (res.status === "done") {
        this.notice = tr("已用 Microsoft 登录 {upn}", { upn: res.upn || accountId });
        this.oauthError = "";
      } else {
        this.oauthError = tr("设备码过期了，重新点一次「Microsoft 登录」");
      }
      this.render();
      await this.reload();
    } catch (err) {
      if (seq !== this.seq) return;
      this.oauth = null;
      this.oauthError = failText(tr("登录没走通"), err);
      this.render();
    }
  }

  private cancelOAuth(accountId: string): void {
    if (this.oauthTimer) window.clearTimeout(this.oauthTimer);
    this.oauthTimer = 0;
    if (this.oauth?.accountId !== accountId) return;
    this.oauth = null;
    this.oauthError = "";
    void api.mailOAuthCancel(accountId).catch(() => {});
    this.render();
  }

  private async logoutOAuth(accountId: string): Promise<void> {
    if (this.oauthBusy) return;
    const seq = this.seq;
    this.oauthBusy = accountId;
    this.oauthError = "";
    this.render();
    try {
      await api.mailOAuthLogout(accountId);
      if (seq !== this.seq) return;
      this.notice = tr("已退出，令牌从本机删掉了");
      await this.reload();
    } catch (err) {
      if (seq !== this.seq) return;
      this.oauthError = failText(tr("没退出成"), err);
    } finally {
      if (seq === this.seq) {
        this.oauthBusy = "";
        this.render();
      }
    }
  }

  /** 邮箱地址：个人邮箱只填 @ 前面的部分，域名由邮箱类型带出来；企业邮 / 自定义整框输入。 */
  private addressField(f: AccountForm): HTMLElement {
    const cfg = this.config!;
    const domain = presetDomain(cfg.presets, f.preset);
    const local = localPartFor(f.address, domain);
    const inp = textInput(local !== null ? local : f.address, local !== null ? "text" : "email", local !== null ? "off" : "email");
    if (local === null) {
      inp.placeholder = "you@example.com";
      inp.oninput = () => (f.address = inp.value);
      return fieldRow(tr("邮箱地址"), inp);
    }
    inp.placeholder = tr("填 @ 前面的部分");
    const domainLabel = el("span", "mc-address__domain", `@${domain}`);
    inp.oninput = () => {
      const raw = inp.value;
      const parts = splitAddress(raw);
      if (!parts) {
        f.address = raw ? joinAddress(raw, domain) : "";
        domainLabel.hidden = false;
        return;
      }
      // 用户开始输入完整地址时先把固定后缀藏起来，避免看起来像两个 @。
      f.address = raw;
      domainLabel.hidden = true;
    };
    // 失焦时只做静态归位，不重画：重画会把光标/点击目标一起换掉。
    inp.onblur = () => {
      const parts = splitAddress(inp.value);
      if (!parts) return;
      if (!parts.domain) {
        inp.value = parts.local;
        f.address = parts.local ? joinAddress(parts.local, domain) : "";
        domainLabel.hidden = false;
        return;
      }
      if (parts.domain.toLowerCase() !== domain.toLowerCase()) return;
      inp.value = parts.local;
      f.address = parts.local ? joinAddress(parts.local, domain) : "";
      domainLabel.hidden = false;
    };
    const wrap = el("div", "mc-address");
    wrap.append(inp, domainLabel);
    return fieldRow(tr("邮箱地址"), wrap);
  }

  private formEl(f: AccountForm): HTMLElement {
    const cfg = this.config!;
    const box = el("section", "mc-section mc-section--form");
    const head = el("div", "mc-section__head");
    head.append(el("div", "mc-section__label", f.id ? tr("改账号") : tr("新账号")));
    head.append(el("div", "mc-section__meta", f.auth === "oauth" ? tr("用 Microsoft 账号登录，不填授权码") : tr("授权码不是登录密码")));
    box.append(head);

    const presetRow = el("label", "mc-field");
    presetRow.append(el("span", "mc-field__label", tr("邮箱类型")));
    const pick = el("select", "mc-select") as HTMLSelectElement;
    for (const id of cfg.presetIds) {
      const opt = el("option", "", id === "custom" ? tr("自定义（手动填服务器）") : this.presetLabel(id, cfg.presets[id]?.label ?? id)) as HTMLOptionElement;
      opt.value = id;
      opt.selected = f.preset === id;
      pick.append(opt);
    }
    pick.onchange = () => {
      const next = pick.value;
      // 先换域名再换预设：地址如果本来就是预设域名，跟着一起换；换到企业邮 / 自定义
      // （没有固定域名）时只留本地部分，避免把旧服务商的地址悄悄带过去。
      const knownDomains = Object.values(cfg.presets).flatMap((p) => (p.domain ? [p.domain] : []));
      f.address = retargetAddress(f.address, presetDomain(cfg.presets, f.preset), presetDomain(cfg.presets, next), knownDomains);
      f.preset = next;
      // 认证方式跟着预设走：Outlook / Microsoft 365 只有 OAuth，别的默认授权码。
      f.auth = this.defaultAuth(cfg, next);
      const [imap, smtp] = this.presetEndpoints(cfg, next);
      f.imapHost = imap.host;
      f.imapPort = String(imap.port);
      f.smtpHost = smtp.host;
      f.smtpPort = String(smtp.port);
      this.render();
      this.focusFirst();
    };
    presetRow.append(pick);
    box.append(presetRow);

    const grid = el("div", "mc-form__grid");
    grid.append(this.addressField(f), formInput(tr("显示名"), f.label, "text", (v) => (f.label = v), "name"));
    box.append(grid);

    const creds = el("div", "mc-form__grid");
    if (f.auth === "oauth") {
      // OAuth 账号：填的是 Entra 里的应用，不碰密码。令牌由「账号」页的登录按钮写进桥。
      creds.append(
        formInput(tr("Microsoft 应用 ID"), f.oauthClientId, "text", (v) => (f.oauthClientId = v)),
        formInput(tr("租户（留空 = common）"), f.oauthTenant, "text", (v) => (f.oauthTenant = v)),
      );
      box.append(creds);
      const who = el("div", "mc-form__grid");
      who.append(formInput(tr("登录账号（留空 = 地址）"), f.user, "text", (v) => (f.user = v), "username"));
      box.append(who);
      box.append(el("div", "mc-hint", tr("登录账号多数就是地址全称；公司邮箱的登录名（UPN）和地址不一样时填那个。")));
      box.append(
        el(
          "div",
          "mc-hint",
          this.config?.accounts.find((a) => a.id === f.id)?.hasToken
            ? tr("应用 ID / 租户改了就要重新登录（旧令牌会作废）。登录令牌只存本机，页面拿不到。")
            : tr("Outlook 个人账号与 Microsoft 365 已经关掉了密码 / 授权码登录，只能用 OAuth。先到 Entra 门户「应用注册」建一个应用（允许公共客户端），把「应用程序(客户端) ID」填到这里；保存后点账号那一行的「Microsoft 登录」完成一次设备码登录。"),
        ),
      );
    } else {
      creds.append(
        formInput(tr("登录账号（多数就是地址全称）"), f.user, "text", (v) => (f.user = v), "username"),
        formInput(tr("客户端授权码"), f.secret, "password", (v) => (f.secret = v), "new-password"),
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
    }

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
        formInput(tr("IMAP 服务器"), f.imapHost, "text", (v) => (f.imapHost = v)),
        formInput(tr("IMAP 端口"), f.imapPort, "number", (v) => (f.imapPort = v)),
        formInput(tr("SMTP 服务器"), f.smtpHost, "text", (v) => (f.smtpHost = v)),
        formInput(tr("SMTP 端口"), f.smtpPort, "number", (v) => (f.smtpPort = v)),
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
      const raw = limit.value.trim();
      const n = Number(raw);
      // 以前非数字会变成 NaN → 存成 0 = 不限：手一拙就把上限拆了。
      if (!raw || !Number.isFinite(n) || n < 0) {
        limit.value = String(cfg.policy.dailySendLimit);
        this.notice = tr("上限要填 0 或正整数，这次没改");
        this.render();
        return;
      }
      void this.savePolicy({ dailySendLimit: Math.floor(n) });
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
    head.append(el("div", "mc-section__label", tr("发送与草稿")));
    head.append(el("div", "mc-section__meta", tr("发送、存草稿与失败各记一笔，不进模型上下文")));
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
        // 草稿也走这个审计文件（桥端 `mail_draft` 记的是 ok + messageId="draft"），只看 `ok`
        // 会把「存进草稿箱」显示成「已发出」——用户以为发出去了，其实信还在草稿箱里。
        const outcome = auditOutcome(row);
        const result =
          outcome === "draft" ? tr("已存草稿") : outcome === "sent" ? tr("已发出") : auditFailText(row.error);
        tr1.append(el("td", "", result));
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
    const address = f.address.trim();
    // 个人邮箱的地址是「本地部分 + 固定域名」，只剩个 @域名 也不能存。
    const domain = this.config ? presetDomain(this.config.presets, f.preset) : "";
    if (!address) {
      this.formError = domain ? tr("邮箱地址要填 @ 前面的部分") : tr("邮箱地址不能空");
      this.render();
      return;
    }
    if (domain) {
      const local = localPartFor(address, domain);
      if (local === null) {
        this.formError = tr("邮箱地址要以 @{domain} 结尾", { domain });
        this.render();
        return;
      }
      if (local === "") {
        this.formError = tr("邮箱地址要填 @ 前面的部分");
        this.render();
        return;
      }
    }
    this.saving = true;
    this.formError = "";
    this.render();
    const seq = this.seq;
    const body: MailAccountInput = {
      label: f.label.trim() || address,
      address,
      preset: f.preset,
      user: f.user.trim() || address,
      secret: f.secret,
      // TLS 由端口算（以前 IMAP 恒 true、SMTP 就看字符串里有没有 587，143 / 25 永远连不上）。
      imap: { host: f.imapHost.trim(), port: portOf(f.imapPort, 993), secure: secureForPort(portOf(f.imapPort, 993), "imap") },
      smtp: { host: f.smtpHost.trim(), port: portOf(f.smtpPort, 465), secure: secureForPort(portOf(f.smtpPort, 465), "smtp") },
    };
    if (f.id) body.id = f.id;
    if (f.auth === "oauth") {
      body.auth = "oauth";
      body.oauthClientId = f.oauthClientId.trim();
      // 留空就交给桥按 common 处理；单租户应用必须自己填租户 ID / 域名。
      body.oauthTenant = f.oauthTenant.trim();
    } else {
      body.auth = "password";
    }
    try {
      const { account } = await api.mailSaveAccount(body);
      if (seq !== this.seq) return;
      this.form = null;
      this.notice = tr("账号已保存");
      await this.reload();
      // OAuth 账号保存完还没令牌：直接接上登录，省得人再回头找那个按钮。
      if (seq === this.seq && account.auth === "oauth" && !account.hasToken) await this.startOAuth(account.id);
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
