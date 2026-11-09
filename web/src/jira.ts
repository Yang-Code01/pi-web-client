/**
 * Jira 面板（#248）：顶栏「🔷 Jira」打开的那扇 dialog。
 *
 * 本单只做「连接」这一层 —— 未连接是表单，连上之后是当前账号；工单列表 / 详情 / 附件是后续
 * 工单。两条边界：
 * - 凭据只在桥那边，这里拿到的永远是掩码；除了桥回的 `avatarUrl`，页面不拼任何 Jira 地址。
 * - 每次 `open()` 都重新问一次桥，不拿内存里的旧状态当已连接（换机器、隧道退连接都能立刻反映）。
 */
import { api } from "./api.ts";
import { createEl as el } from "./chat.ts";
import { errText, tr } from "./i18n/index.ts";

export interface JiraHost {
  /** 底部那行 MCP 提示的落点：直接开到设置里的「扩展与 MCP」。 */
  settings(tab: "ext"): void;
}

export interface JiraMe {
  accountId: string;
  displayName: string;
  email: string;
  timezone: string;
  avatarUrl: string;
}

interface JiraConfigView {
  configured: boolean;
  siteUrl: string;
  email: string;
  keyMask: string;
}

type PanelState =
  | { kind: "loading" }
  | { kind: "form"; note: string; bad: boolean }
  | { kind: "ready"; me: JiraMe; mask: string }
  | { kind: "error"; text: string; code: string; retry: boolean };

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function withScheme(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function isIpLiteral(host: string): boolean {
  return (host.startsWith("[") && host.endsWith("]")) || IPV4.test(host);
}

/**
 * 站点地址的毛病（中文原因）或 null。桥侧 `bridge/src/jira.ts` 的 `siteUrlProblem` 是权威，
 * 这里只是边填边提示 —— 两边都改才算改完。
 */
export function siteUrlProblem(raw: string): string | null {
  const text = raw.trim();
  if (!text) return tr("请填 Jira 站点地址");
  let url: URL;
  try {
    url = new URL(withScheme(text));
  } catch {
    return tr("站点地址看不懂，检查一下有没有写错");
  }
  if (url.protocol !== "https:") return tr("只接受 https:// 的站点地址");
  if (url.username || url.password) return tr("站点地址里不要带用户名或密码");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return tr("站点地址不能是 localhost");
  if (host.endsWith(".local") || host.endsWith(".internal")) return tr("站点地址不能是内网域名");
  if (isIpLiteral(host)) return tr("站点地址不能是 IP，请填 https://<团队>.atlassian.net");
  if (!host.includes(".")) return tr("站点地址要是一个完整的域名");
  if (url.pathname.replace(/\/+$/, "")) return tr("站点地址只填到域名，不要带路径");
  if (url.search) return tr("站点地址不要带查询参数");
  if (url.hash) return tr("站点地址不要带 #");
  return null;
}

/** 与桥同一口径的掩码：`••••` + 后 4 位。 */
export function keyMask(key: string): string {
  const k = key.trim();
  return k.length > 4 ? `••••${k.slice(-4)}` : "••••";
}

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

export class JiraPanel {
  private readonly host: JiraHost;
  private root: HTMLElement | null = null;
  private state: PanelState = { kind: "loading" };
  private config: JiraConfigView | null = null;
  /** 表单的当前值：每次重画都从这里恢复，别让一次渲染把用户敲的字弄丢。 */
  private form = { siteUrl: "", email: "", apiKey: "" };
  private saving = false;
  /** 关闭 / 重开时作废还在路上的请求。 */
  private seq = 0;
  private lastFocus: HTMLElement | null = null;
  private esc: ((ev: KeyboardEvent) => void) | null = null;

  constructor(host: JiraHost) {
    this.host = host;
  }

  open(): void {
    if (this.root) this.close();
    this.lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.state = { kind: "loading" };
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

  /** 语言切了：整块重画；表单值在 `this.form` 里，不会丢。 */
  refreshLang(): void {
    if (this.root) this.render();
  }

  // -------------------------------------------------------------- 状态流转

  private async reload(): Promise<void> {
    const seq = ++this.seq;
    try {
      const config = await api.jiraConfig();
      if (seq !== this.seq || !this.root) return;
      this.config = config;
      if (!config.configured) {
        this.form = { siteUrl: config.siteUrl || this.form.siteUrl, email: config.email || this.form.email, apiKey: "" };
        this.state = { kind: "form", note: "", bad: false };
        this.render();
        this.focusFirst();
        return;
      }
      await this.loadMe(seq);
    } catch (err) {
      if (seq !== this.seq) return;
      this.showError(err, true);
    }
  }

  private async loadMe(seq = this.seq): Promise<void> {
    try {
      const me = await api.jiraMe();
      if (seq !== this.seq || !this.root) return;
      this.state = { kind: "ready", me, mask: this.config?.keyMask ?? "" };
    } catch (err) {
      if (seq !== this.seq) return;
      this.showError(err, true);
      return;
    }
    this.render();
  }

  private showError(err: unknown, retry: boolean): void {
    this.state = { kind: "error", text: errText(err), code: codeOf(err), retry };
    this.render();
  }

  /** 401 之后「去改 token」：站点 / 邮箱留着，token 重新填。 */
  private showForm(note = "", bad = false): void {
    const config = this.config;
    this.form = { siteUrl: config?.siteUrl || this.form.siteUrl, email: config?.email || this.form.email, apiKey: "" };
    this.state = { kind: "form", note, bad };
    this.render();
    this.focusFirst();
  }

  private async save(): Promise<void> {
    if (this.saving) return;
    const problem = siteUrlProblem(this.form.siteUrl);
    if (problem) {
      this.state = { kind: "form", note: problem, bad: true };
      this.render();
      this.focusFirst();
      return;
    }
    if (!this.form.email.trim()) {
      this.state = { kind: "form", note: tr("请填 Jira 账号邮箱"), bad: true };
      this.render();
      return;
    }
    if (!this.form.apiKey.trim()) {
      this.state = { kind: "form", note: tr("请填 API token"), bad: true };
      this.render();
      return;
    }

    this.saving = true;
    this.state = { kind: "form", note: tr("正在让 Jira 验证这组凭据…"), bad: false };
    this.render();
    try {
      const out = await api.jiraSave({
        siteUrl: this.form.siteUrl.trim(),
        email: this.form.email.trim(),
        apiKey: this.form.apiKey.trim(),
      });
      if (!this.root) return;
      this.config = { configured: true, siteUrl: this.form.siteUrl.trim(), email: this.form.email.trim(), keyMask: "" };
      this.state = { kind: "ready", me: out.me, mask: keyMask(this.form.apiKey) };
      // 验证过就把它从输入框里抹掉：留在页面上没有用，只会多一处能截到图的地方。
      this.form.apiKey = "";
    } catch (err) {
      if (!this.root) return;
      this.state = { kind: "form", note: errText(err), bad: true };
    } finally {
      this.saving = false;
    }
    this.render();
  }

  private async disconnect(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    this.render();
    try {
      await api.jiraClear();
      if (!this.root) return;
      this.config = null;
      this.form = { siteUrl: "", email: "", apiKey: "" };
      this.state = { kind: "form", note: tr("已退出连接"), bad: false };
    } catch (err) {
      if (!this.root) return;
      this.state = { kind: "error", text: errText(err), code: codeOf(err), retry: true };
    } finally {
      this.saving = false;
    }
    this.render();
    this.focusFirst();
  }

  private focusFirst(): void {
    this.root?.querySelector<HTMLInputElement>(".jira-form input")?.focus();
  }

  // -------------------------------------------------------------- 渲染

  private render(): void {
    const back = el("div", "sheet-back jira-back");
    back.onclick = (ev) => {
      if (ev.target === back) this.close();
    };
    const sheet = el("div", "sheet jira-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", tr("Jira"));

    const head = el("div", "sheet-head jira-head");
    head.append(el("div", "sheet-title", tr("🔷 Jira")));
    const close = el("button", "btn ghost jira-close", "×");
    close.title = tr("关闭");
    close.setAttribute("aria-label", tr("关闭"));
    close.onclick = () => this.close();
    head.append(close);

    const body = el("div", "jira-body");
    if (this.state.kind === "loading") body.append(el("div", "jira-loading", tr("正在问桥…")));
    else if (this.state.kind === "form") body.append(this.formEl(this.state));
    else if (this.state.kind === "ready") body.append(this.profileEl(this.state));
    else body.append(this.errorEl(this.state));

    sheet.append(head, body, this.footEl());
    back.append(sheet);
    // 挂 `#app` 里，不挂 `document.body`：外观「字号」是 `#app { zoom: var(--ui-scale) }`，
    // 挂 body 上的弹层不跟它缩（与 notesheet / scratch 同一条理由）。
    if (this.root) this.root.replaceWith(back);
    else (document.getElementById("app") ?? document.body).append(back);
    this.root = back;
  }

  private formEl(state: { note: string; bad: boolean }): HTMLElement {
    const box = el("div", "jira-form");

    const site = el("input", "jira-input") as HTMLInputElement;
    site.type = "url";
    site.value = this.form.siteUrl;
    site.placeholder = "https://acme.atlassian.net";
    site.autocomplete = "off";
    site.spellcheck = false;
    const siteHint = el("div", "jira-hint", "");
    site.oninput = () => {
      this.form.siteUrl = site.value;
      const problem = site.value.trim() ? siteUrlProblem(site.value) : null;
      siteHint.textContent = problem ?? "";
      siteHint.classList.toggle("bad", problem !== null);
    };
    if (this.form.siteUrl.trim()) {
      const problem = siteUrlProblem(this.form.siteUrl);
      siteHint.textContent = problem ?? "";
      siteHint.classList.toggle("bad", problem !== null);
    }

    const email = el("input", "jira-input") as HTMLInputElement;
    email.type = "email";
    email.value = this.form.email;
    email.placeholder = "you@acme.com";
    email.autocomplete = "off";
    email.spellcheck = false;
    email.oninput = () => {
      this.form.email = email.value;
    };

    const token = el("input", "jira-input") as HTMLInputElement;
    token.type = "password";
    token.value = this.form.apiKey;
    token.placeholder = "ATATT…";
    token.autocomplete = "off";
    token.spellcheck = false;
    token.oninput = () => {
      this.form.apiKey = token.value;
    };

    box.append(this.field(tr("Jira 站点"), site, siteHint));
    box.append(this.field(tr("邮箱"), email));
    box.append(this.field(tr("API token"), token));

    const help = el("div", "jira-help");
    const link = el("a", "jira-link", tr("去 Atlassian 建 API token"));
    link.href = "https://id.atlassian.com/manage-profile/security/api-tokens";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    help.append(link);
    box.append(help);

    if (state.note) box.append(el("div", state.bad ? "jira-note bad" : "jira-note", state.note));

    const actions = el("div", "jira-actions");
    const save = el("button", "btn primary", this.saving ? tr("验证中…") : tr("保存并验证"));
    save.disabled = this.saving;
    save.onclick = () => void this.save();
    actions.append(save);
    box.append(actions);
    return box;
  }

  private field(label: string, input: HTMLInputElement, hint?: HTMLElement): HTMLElement {
    const wrap = el("div", "jira-field");
    const id = `jira-${label.replace(/\s+/g, "-")}`;
    const text = el("label", "jira-label", label);
    text.htmlFor = id;
    input.id = id;
    wrap.append(text, input);
    if (hint) wrap.append(hint);
    return wrap;
  }

  private profileEl(state: { me: JiraMe; mask: string }): HTMLElement {
    const me = state.me;
    const box = el("div", "jira-profile");
    const card = el("div", "jira-card");

    const who = el("div", "jira-who");
    who.append(el("div", "jira-name", me.displayName || tr("（没有名字）")));
    if (me.email) who.append(el("div", "jira-mail", me.email));

    const initial = (me.displayName.trim() || me.email.trim() || "?").slice(0, 1).toUpperCase();
    const avatar = el("img", "jira-avatar") as HTMLImageElement;
    avatar.alt = "";
    avatar.src = "/api/jira/me/avatar";
    // 取不到就安静地退回首字母 —— 破图比没有头像更难看。
    avatar.onerror = () => avatar.replaceWith(el("span", "jira-avatar jira-avatar-fallback", initial));
    card.append(avatar, who);
    box.append(card);

    const rows = el("div", "jira-rows");
    rows.append(this.row(tr("时区"), me.timezone || "—"));
    rows.append(this.row(tr("API token"), state.mask || "—"));
    box.append(rows);

    const actions = el("div", "jira-actions");
    const out = el("button", "btn ghost jira-disconnect", tr("退出连接"));
    out.disabled = this.saving;
    out.onclick = () => void this.disconnect();
    actions.append(out);
    box.append(actions);
    return box;
  }

  private row(key: string, value: string): HTMLElement {
    const line = el("div", "jira-row");
    line.append(el("span", "jira-k", key), el("span", "jira-v", value));
    return line;
  }

  private errorEl(state: { text: string; code: string; retry: boolean }): HTMLElement {
    const box = el("div", "jira-error");
    box.append(el("div", "jira-error-text", state.text));
    const actions = el("div", "jira-actions");
    if (state.code === "jira_auth" || state.code === "jira_forbidden") {
      const fix = el("button", "btn primary", tr("去改 token"));
      fix.onclick = () => this.showForm(state.text, true);
      actions.append(fix);
    } else if (state.retry) {
      const again = el("button", "btn ghost", tr("重试"));
      again.onclick = () => {
        this.state = { kind: "loading" };
        this.render();
        void this.reload();
      };
      actions.append(again);
    }
    box.append(actions);
    return box;
  }

  /** 底部固定一行 MCP 提示：本单不探测 MCP 装没装，只把人送到设置页（D201）。 */
  private footEl(): HTMLElement {
    const foot = el("div", "jira-foot");
    foot.append(el("span", "jira-mcp", tr("读工单描述和评论要用 Jira MCP：在「设置 → 扩展与 MCP」里安装。")));
    const go = el("button", "btn ghost", tr("打开设置"));
    go.onclick = () => {
      this.host.settings("ext");
      this.close();
    };
    foot.append(go);
    return foot;
  }
}
