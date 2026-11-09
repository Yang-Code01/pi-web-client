/**
 * Jira 面板（#248、#249）：顶栏「🔷 Jira」打开的那扇 dialog。
 *
 * #248 做「连接」这一层（表单 / 当前账号）；#249 在 ready 态下再放两段列表：「我的未完成」与
 * 「可访问项目」。两条边界：
 * - 凭据只在桥那边，这里拿到的永远是掩码；除了桥回的 `avatarUrl`，页面不拼任何 Jira 地址。
 * - 每次 `open()` 都重新问一次桥，不拿内存里的旧状态当已连接（换机器、隧道退连接都能立刻反映）；
 *   列表本身不缓存，60 秒的复用是桥那边的责任（D202）。
 */
import { api } from "./api.ts";
import { createEl as el } from "./chat.ts";
import { mountDirPicker } from "./dirpicker.ts";
import type { DirPicker } from "./dirpicker.ts";
import { errText, tr } from "./i18n/index.ts";
import { adfToText, browseUrl, downloadMark, formatBytes, formatUpdated, handoffPrompt, issueMeta, keyMask, siteUrlProblem } from "./jira-shared.ts";
import type { JiraDownloadResult, JiraIssue, JiraIssueDetail, JiraProject } from "./jira-shared.ts";

// 纯函数单独一层，`web/tests/jira-unit.mjs` 才能绕开 chat.ts 直接跑（见 jira-shared.ts 头注释）。
export { keyMask, siteUrlProblem } from "./jira-shared.ts";

export interface JiraHandoff {
  /** 只把提示词放进当前输入框，不发送。 */
  prefill(text: string): void;
  /** 开一个新会话，建好后把提示词填进它的输入框，不自动发送。 */
  newSessionWith(text: string): void;
}

export interface JiraHost {
  /** 底部那行 MCP 提示的落点：直接开到设置里的「扩展与 MCP」。 */
  settings(tab: "ext"): void;
  /** #252：交给 agent 的两个出口；没接上时浮层里给一行错误，不静默。 */
  handoff?: JiraHandoff;
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

type ListState<T> =
  | { kind: "loading" }
  | { kind: "ready"; items: T[] }
  | { kind: "error"; text: string; code: string };

type PanelState =
  | { kind: "loading" }
  | { kind: "form"; note: string; bad: boolean }
  | {
      kind: "ready";
      me: JiraMe;
      mask: string;
      siteUrl: string;
      issues: ListState<JiraIssue>;
      projects: ListState<JiraProject>;
      refreshing: boolean;
      /** 刷新失败时的一行错误；旧列表留着，不清空。 */
      refreshNote: string;
    }
  | { kind: "error"; text: string; code: string; retry: boolean };

type ReadyState = Extract<PanelState, { kind: "ready" }>;

type DetailState =
  | { kind: "loading" }
  | { kind: "ready"; data: JiraIssueDetail }
  | { kind: "error"; text: string; code: string };

/** 每行的展开状态 + 已经取到的详情（#250）：`state === null` 表示还没请求过。 */
interface DetailEntry {
  open: boolean;
  state: DetailState | null;
  /** 当前这行详情块的 DOM；整块重画后由 `issueEl` 换成新元素。 */
  el: HTMLElement | null;
  /** #251：正在下载（按钮禁用 + 文案「正在下载…」）。 */
  busy: boolean;
  /** 上一批下载的结果；null = 还没下过或刚刚失败。 */
  download: JiraDownloadResult | null;
  /** 整单失败的理由（隧道 403、目录写不进去…）；单项的理由在 item.reason 上。 */
  dlError: string;
}

/** 描述超过这个字数就截断，并给一个「在新窗口打开」。 */
const DESC_LIMIT = 800;

function isAuthCode(code: string): boolean {
  return code === "jira_auth" || code === "jira_forbidden";
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
  /** #250：展开的行与详情缓存（面板实例内存，不落盘、桥也不缓存，D203）。 */
  private details = new Map<string, DetailEntry>();
  /** #251：附件根目录（null = 没设）；每次 open / 连接成功后向桥问一次，不信旧值。 */
  private attachRoot: string | null = null;
  /** 内嵌在面板里的目录选择层；`null` = 没开。 */
  private pickerLayer: HTMLElement | null = null;
  /** #252：交给 agent 的浮层；`off` 摘掉浮层自己的全局监听（外点 / 滚动 / 尺寸变化）。 */
  private handoffPop: { el: HTMLElement; timer: number; off: () => void } | null = null;

  constructor(host: JiraHost) {
    this.host = host;
  }

  open(): void {
    if (this.root) this.close();
    // 每次重开都从干净的详情开始：换账号 / 换站点后旧工单的详情不该继续显示。
    this.details.clear();
    this.lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.state = { kind: "loading" };
    this.esc = (ev) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      // 交给 agent 的浮层最轻：Esc 先只收它（与目录层同理，一下关两层太粗）。
      if (this.handoffPop) {
        this.closeHandoff();
        return;
      }
      // 目录选择层开着时，Esc 只收这一层：一下关两层太粗（D204 的「改」也不该顺手关掉面板）。
      if (this.pickerLayer) {
        this.closePicker();
        return;
      }
      this.close();
    };
    document.addEventListener("keydown", this.esc, true);
    this.render();
    void this.reload();
  }

  close(): void {
    this.closeHandoff();
    this.closePicker();
    if (this.esc) document.removeEventListener("keydown", this.esc, true);
    this.esc = null;
    this.seq += 1;
    this.root?.remove();
    this.root = null;
    const back = this.lastFocus;
    this.lastFocus = null;
    back?.focus();
  }

  /** 语言切了：整块重画；表单值在 `this.form` 里，列表在 `this.state` 里，不会丢也不重新请求。 */
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
      await this.loadAttachRoot();
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
      this.state = this.listsPending(me, this.config?.keyMask ?? "");
    } catch (err) {
      if (seq !== this.seq) return;
      this.showError(err, true);
      return;
    }
    this.render();
    await this.loadLists(seq, false);
  }

  /** 刚进 ready 态时列表还不知道：先占位（不抽动布局），再由 `loadLists` 填上。 */
  private listsPending(me: JiraMe, mask: string): PanelState {
    return {
      kind: "ready",
      me,
      mask,
      siteUrl: this.config?.siteUrl ?? this.form.siteUrl.trim(),
      issues: { kind: "loading" },
      projects: { kind: "loading" },
      refreshing: false,
      refreshNote: "",
    };
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
    let waitLists = false;
    try {
      const out = await api.jiraSave({
        siteUrl: this.form.siteUrl.trim(),
        email: this.form.email.trim(),
        apiKey: this.form.apiKey.trim(),
      });
      if (!this.root) return;
      const mask = keyMask(this.form.apiKey);
      this.config = { configured: true, siteUrl: this.form.siteUrl.trim(), email: this.form.email.trim(), keyMask: mask };
      this.details.clear();
      await this.loadAttachRoot();
      this.state = this.listsPending(out.me, mask);
      waitLists = true;
      // 验证过就把它从输入框里抹掉：留在页面上没有用，只会多一处能截到图的地方。
      this.form.apiKey = "";
    } catch (err) {
      if (!this.root) return;
      this.state = { kind: "form", note: errText(err), bad: true };
    } finally {
      this.saving = false;
    }
    this.render();
    if (waitLists) void this.loadLists(this.seq, false);
  }

  private async disconnect(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    this.render();
    try {
      await api.jiraClear();
      if (!this.root) return;
      this.config = null;
      this.details.clear();
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
    else if (this.state.kind === "ready") body.append(this.readyEl(this.state));
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

  // -------------------------------------------------------------- 我的未完成 / 可访问项目

  /** 并行拉两段列表；没到货时保持占位。「刷新」失败不动旧列表，只多一行错误。 */
  private async loadLists(seq: number, refresh: boolean): Promise<void> {
    const [issues, projects] = await Promise.allSettled([api.jiraIssues(refresh), api.jiraProjects(refresh)]);
    if (seq !== this.seq || !this.root || this.state.kind !== "ready") return;
    const prev = this.state;

    let nextIssues: ListState<JiraIssue>;
    let note = "";
    if (issues.status === "fulfilled") {
      nextIssues = { kind: "ready", items: issues.value.issues };
    } else {
      const code = codeOf(issues.reason);
      if (refresh && !isAuthCode(code) && prev.issues.kind === "ready") {
        // 强制刷新失败时不把已经读到的列表清掉，只提示这次没取到新的。
        nextIssues = prev.issues;
        note = tr("刷新失败：{p1}", { p1: errText(issues.reason) });
      } else {
        nextIssues = { kind: "error", text: errText(issues.reason), code };
      }
    }

    const nextProjects: ListState<JiraProject> =
      projects.status === "fulfilled"
        ? { kind: "ready", items: projects.value.projects }
        : { kind: "error", text: errText(projects.reason), code: codeOf(projects.reason) };

    this.state = { ...prev, issues: nextIssues, projects: nextProjects, refreshing: false, refreshNote: note };
    this.render();
  }

  private async refreshLists(): Promise<void> {
    if (this.state.kind !== "ready" || this.state.refreshing) return;
    this.state = { ...this.state, refreshing: true, refreshNote: "" };
    this.render();
    await this.loadLists(this.seq, true);
  }

  private readyEl(state: ReadyState): HTMLElement {
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
    rows.append(this.attachRootRow());
    box.append(rows);

    box.append(this.issuesEl(state));
    const projects = this.projectsEl(state);
    if (projects) box.append(projects);

    const actions = el("div", "jira-actions");
    const out = el("button", "btn ghost jira-disconnect", tr("退出连接"));
    out.disabled = this.saving;
    out.onclick = () => void this.disconnect();
    actions.append(out);
    box.append(actions);
    return box;
  }

  private issuesEl(state: ReadyState): HTMLElement {
    const sec = el("div", "jira-section jira-issues");
    const head = el("div", "jira-section-head");
    head.append(el("div", "jira-section-title", tr("我的未完成")));
    const refresh = el("button", "btn ghost jira-refresh", "↻");
    refresh.title = tr("刷新");
    refresh.setAttribute("aria-label", tr("刷新"));
    refresh.disabled = state.refreshing || state.issues.kind === "loading";
    refresh.onclick = () => void this.refreshLists();
    head.append(refresh);
    sec.append(head);

    if (state.refreshNote) sec.append(el("div", "jira-note bad", state.refreshNote));

    if (state.issues.kind === "loading") {
      sec.append(el("div", "jira-list-placeholder", tr("正在读取…")));
    } else if (state.issues.kind === "error") {
      if (isAuthCode(state.issues.code)) {
        const expired = el("div", "jira-expired");
        expired.append(el("div", "jira-note bad", tr("凭据失效，改一下 token 再试")));
        const fix = el("button", "btn primary", tr("去改 token"));
        fix.onclick = () => this.showForm(tr("重新填一次 token"), true);
        expired.append(fix);
        sec.append(expired);
      } else {
        sec.append(el("div", "jira-list-error", state.issues.text));
      }
    } else if (state.issues.items.length === 0) {
      sec.append(el("div", "jira-empty", tr("没有分配给你且未完成的工单")));
    } else {
      const list = el("div", "jira-list");
      for (const issue of state.issues.items) list.append(this.issueEl(state.siteUrl, issue));
      sec.append(list);
    }
    return sec;
  }

  /** 项目取不到或为空时整段不渲染（标题也不留）。 */
  private projectsEl(state: ReadyState): HTMLElement | null {
    if (state.projects.kind !== "ready" || state.projects.items.length === 0) return null;
    const sec = el("div", "jira-section jira-projects");
    const head = el("div", "jira-section-head");
    head.append(el("div", "jira-section-title", tr("可访问项目")));
    sec.append(head);

    const chips = el("div", "jira-chips");
    for (const project of state.projects.items) {
      const chip = el("a", "jira-chip", project.name || project.key);
      chip.href = browseUrl(state.siteUrl, project.key);
      chip.target = "_blank";
      chip.rel = "noopener noreferrer";
      chip.title = project.name ? `${project.key} · ${project.name}` : project.key;
      chips.append(chip);
    }
    sec.append(chips);
    return sec;
  }

  /** 点一行就地展开 / 收起详情（#250）：不重画列表，滚动位置自然不动。 */
  private issueEl(siteUrl: string, issue: JiraIssue): HTMLElement {
    const wrap = el("div", "jira-issue-wrap");
    const line = el("div", "jira-issue");
    const top = el("div", "jira-issue-top");
    const key = el("a", "jira-issue-key", issue.key);
    key.href = browseUrl(siteUrl, issue.key);
    key.target = "_blank";
    key.rel = "noopener noreferrer";
    top.append(key, el("span", "jira-issue-summary", issue.summary || tr("（没有标题）")));
    top.append(this.handoffButton(issue, siteUrl));
    line.append(top);
    const meta = issueMeta(issue);
    if (meta) line.append(el("div", "jira-issue-meta", meta));

    const entry = this.details.get(issue.key);
    const detail = el("div", "jira-detail");
    line.classList.toggle("open", entry?.open === true);
    line.tabIndex = 0;
    line.setAttribute("role", "button");
    line.setAttribute("aria-expanded", entry?.open ? "true" : "false");
    const toggle = () => this.toggleDetail(issue.key, siteUrl, detail);
    line.onclick = (ev) => {
      // key 是「去 Jira 看」的链接，行内的按钮有自己的动作：两者都不当展开 / 收起。
      if ((ev.target as HTMLElement).closest("a, button")) return;
      toggle();
    };
    line.onkeydown = (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      if ((ev.target as HTMLElement).closest("a, button")) return;
      ev.preventDefault();
      toggle();
    };

    wrap.append(line, detail);
    if (entry) {
      entry.el = detail;
      this.paintDetail(entry, siteUrl, issue.key);
    }
    return wrap;
  }

  private toggleDetail(key: string, siteUrl: string, box: HTMLElement): void {
    const entry = this.details.get(key) ?? { open: false, state: null, el: box, busy: false, download: null, dlError: "" };
    entry.el = box;
    entry.open = !entry.open;
    this.details.set(key, entry);
    const line = box.parentElement?.querySelector<HTMLElement>(".jira-issue");
    line?.classList.toggle("open", entry.open);
    line?.setAttribute("aria-expanded", entry.open ? "true" : "false");
    this.paintDetail(entry, siteUrl, key);
    // 收起再展开不重请求：只有第一次展开（state 还是 null）才去问桥。
    if (entry.open && entry.state === null) void this.loadDetail(key, siteUrl);
  }

  /** 详情只影响这一行：请求失败也只在这一行里显示错误 + 重试。 */
  private async loadDetail(key: string, siteUrl: string): Promise<void> {
    const seq = this.seq;
    const entry = this.details.get(key);
    if (!entry) return;
    entry.state = { kind: "loading" };
    this.paintDetail(entry, siteUrl, key);
    try {
      const data = await api.jiraIssue(key);
      const current = this.details.get(key);
      if (!current || seq !== this.seq) return;
      current.state = { kind: "ready", data };
      this.paintDetail(current, siteUrl, key);
    } catch (err) {
      const current = this.details.get(key);
      if (!current || seq !== this.seq) return;
      current.state = { kind: "error", text: errText(err), code: codeOf(err) };
      this.paintDetail(current, siteUrl, key);
    }
  }

  private paintDetail(entry: DetailEntry, siteUrl: string, key: string): void {
    const box = entry.el;
    if (!box) return;
    box.replaceChildren();
    box.classList.toggle("open", entry.open);
    if (!entry.open || !entry.state) return;
    const state = entry.state;

    if (state.kind === "loading") {
      box.append(el("div", "jira-detail-loading", tr("正在读取详情…")));
      return;
    }
    if (state.kind === "error") {
      box.append(el("div", "jira-detail-error", state.text));
      const actions = el("div", "jira-actions");
      const again = el("button", "btn ghost", tr("重试"));
      again.onclick = () => void this.loadDetail(key, siteUrl);
      actions.append(again);
      box.append(actions);
      return;
    }

    const data = state.data;
    const desc = el("div", "jira-desc");
    const text = adfToText(data.issue.description);
    if (!text) {
      desc.append(el("div", "jira-desc-empty", tr("没有描述")));
    } else {
      const cut = text.length > DESC_LIMIT;
      desc.append(el("div", "jira-desc-text", cut ? `${text.slice(0, DESC_LIMIT)}…` : text));
      if (cut) {
        const more = el("a", "jira-link", tr("在新窗口打开"));
        more.href = browseUrl(siteUrl, key);
        more.target = "_blank";
        more.rel = "noopener noreferrer";
        desc.append(more);
      }
    }
    box.append(desc);

    // 两段附件：空的那段整段不渲染（标题也不留）。只列不下载（#251 才谈下载）。
    const parts = [
      { title: tr("issue 附件"), items: data.attachments.issue },
      { title: tr("评论附件"), items: data.attachments.comments },
    ];
    for (const part of parts) {
      if (part.items.length === 0) continue;
      const sec = el("div", "jira-attachments");
      sec.append(el("div", "jira-section-title", part.title));
      for (const item of part.items) {
        const row = el("div", "jira-attach");
        row.append(el("div", "jira-attach-name", item.filename || tr("（没有文件名）")));
        const info = [formatBytes(item.size), item.author, formatUpdated(item.created)].filter(Boolean).join(" · ");
        if (info) row.append(el("div", "jira-attach-meta", info));
        sec.append(row);
      }
      box.append(sec);
    }

    box.append(this.downloadEl(entry, key, siteUrl));

    // #252：详情底部也能直接交给 agent（工单信息与行内那颗用同一份）。
    const bar = el("div", "jira-handoff-bar");
    bar.append(this.handoffButton(data.issue, siteUrl));
    box.append(bar);
  }

  /** #251：下载按钮 + 结果就地显示，不再弹第二层结果窗。 */
  private downloadEl(entry: DetailEntry, key: string, siteUrl: string): HTMLElement {
    const box = el("div", "jira-download");
    const bar = el("div", "jira-actions");
    const btn = el("button", "btn primary jira-dl-btn", entry.busy ? tr("正在下载…（一次一个）") : tr("下载全部")) as HTMLButtonElement;
    btn.disabled = entry.busy;
    btn.onclick = () => void this.downloadAll(key, siteUrl, entry);
    bar.append(btn);
    box.append(bar);
    if (entry.dlError) box.append(el("div", "jira-note bad", entry.dlError));
    const result = entry.download;
    if (!result) return box;

    const dir = el("div", "jira-dl-dir");
    dir.append(el("span", "jira-dl-dir-k", tr("已保存到")), el("span", "jira-dl-dir-v", result.dir));
    dir.title = result.dir;
    box.append(dir);
    for (const item of result.items) {
      const row = el("div", `jira-dl-item ${item.status}`);
      row.title = item.path;
      const text = el("div", "jira-dl-text");
      text.append(el("div", "jira-dl-name", item.filename || tr("（没有文件名）")));
      text.append(el("div", "jira-dl-path", item.path));
      if (item.reason) text.append(el("div", "jira-dl-reason", item.reason));
      row.append(el("span", "jira-dl-mark", downloadMark(item.status)), text);
      box.append(row);
    }
    return box;
  }

  /** #251：整单一次 POST；桥那边串行落盘，单项失败只失败那一项。 */
  private async downloadAll(key: string, siteUrl: string, entry: DetailEntry, retried = false): Promise<void> {
    if (entry.busy) return;
    entry.busy = true;
    entry.dlError = "";
    this.paintDetail(entry, siteUrl, key);
    try {
      const out = await api.jiraDownload(key);
      const current = this.details.get(key) ?? entry;
      current.download = out;
      current.dlError = "";
    } catch (err) {
      const current = this.details.get(key) ?? entry;
      current.download = null;
      // 第一次点还没设目录：弹选择器，选完自动重试一次（只一次，不再弹）。
      if (codeOf(err) === "need_root" && !retried) {
        current.busy = false;
        this.paintDetail(current, siteUrl, key);
        this.openRootPicker(() => void this.downloadAll(key, siteUrl, current, true));
        return;
      }
      current.dlError = errText(err);
    } finally {
      const current = this.details.get(key) ?? entry;
      current.busy = false;
    }
    const current = this.details.get(key) ?? entry;
    this.paintDetail(current, siteUrl, key);
  }

  // -------------------------------------------------------------- 交给 agent（#252）

  /** 行尾与详情底部共用的一颗。点在行里时不能冒泡成「展开 / 收起」。 */
  private handoffButton(issue: JiraIssue, siteUrl: string): HTMLButtonElement {
    const btn = el("button", "btn ghost jira-handoff", tr("交给 agent ▾"));
    btn.onclick = (ev) => {
      ev.stopPropagation();
      this.openHandoffMenu(btn, issue, siteUrl);
    };
    return btn;
  }

  /**
   * 浮层的一份拷贝（笔记面板 `notesheet.ts` 的 `handoffMenu`，按用户要求不抽共用件）：
   * 两项文案与那边完全一致，点外面 / Esc / 滚动 / 改尺寸都关，放不下就翻到锚点上方。
   */
  private openHandoffMenu(anchor: HTMLElement, issue: JiraIssue, siteUrl: string): void {
    this.closeHandoff();
    const pop = el("div", "jira-handoff-pop");
    pop.style.position = "fixed";
    const r = anchor.getBoundingClientRect();
    // 左右夹进窗口；先贴在锚点下方，量过高度再决定要不要翻上去。
    pop.style.left = `${Math.max(12, Math.min(r.right - 260, innerWidth - 274))}px`;
    pop.style.top = `${r.bottom + 6}px`;
    pop.style.visibility = "hidden";
    const err = el("div", "jira-handoff-err");
    err.hidden = true;
    const add = (label: string, hint: string, run: () => void) => {
      const b = el("button");
      b.append(el("span", "handoff-label", label), el("span", "handoff-hint", hint));
      b.onclick = () => run();
      pop.append(b);
    };
    add(tr("预填到当前会话"), tr("写进输入框，Enter 才发"), () => void this.handoffRun(pop, err, issue, siteUrl, "prefill"));
    add(tr("新开一个会话"), tr("建好后填进那个会话的输入框，不自动发送"), () => void this.handoffRun(pop, err, issue, siteUrl, "new"));
    pop.append(err);
    document.body.append(pop);
    // 下方放不下且上方更宽裕就翻上去；上下都窄就贴窗口顶，不让浮层探出窗口。
    const h = pop.offsetHeight;
    const below = innerHeight - r.bottom - 6 - 12;
    if (h > below && r.top - 6 - 12 > below) pop.style.top = `${Math.max(12, r.top - 6 - h)}px`;
    pop.style.visibility = "";

    const onOutside = (ev: Event) => {
      if (!pop.contains(ev.target as Node)) this.closeHandoff();
    };
    const onMove = () => this.closeHandoff();
    // 打开浮层的这一下 click 还在冒泡：下一轮再挂外点监听，否则它立刻把自己关掉。
    const timer = window.setTimeout(() => document.addEventListener("click", onOutside), 0);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    this.handoffPop = {
      el: pop,
      timer,
      off: () => {
        window.clearTimeout(timer);
        document.removeEventListener("click", onOutside);
        window.removeEventListener("scroll", onMove, true);
        window.removeEventListener("resize", onMove);
      },
    };
  }

  /** 只收浮层，不动 Jira 面板（预填完用户可能还想看别的工单）。 */
  private closeHandoff(): void {
    const pop = this.handoffPop;
    if (!pop) return;
    pop.off();
    pop.el.remove();
    this.handoffPop = null;
  }

  /**
   * #252：这单已经下到哪了。详情里刚下载过就复用那个目录，否则问桥；问不到按「没下过」处理，
   * 不阻断交接（少一行路径总比交不出去好）。
   */
  private async downloadedDir(key: string): Promise<string | null> {
    const known = this.details.get(key)?.download?.dir;
    if (known) return known;
    try {
      return (await api.jiraDownloaded(key)).dir;
    } catch {
      return null;
    }
  }

  private async handoffRun(
    pop: HTMLElement,
    err: HTMLElement,
    issue: JiraIssue,
    siteUrl: string,
    kind: "prefill" | "new",
  ): Promise<void> {
    const dir = await this.downloadedDir(issue.key);
    const text = handoffPrompt({
      key: issue.key,
      summary: issue.summary,
      siteUrl,
      status: issue.status,
      priority: issue.priority,
      type: issue.type,
      dir,
    });
    try {
      const handoff = this.host.handoff;
      if (!handoff) throw new Error(tr("没有可用的会话出口"));
      if (kind === "prefill") handoff.prefill(text);
      else handoff.newSessionWith(text);
      this.closeHandoff();
    } catch (e) {
      if (this.handoffPop?.el !== pop) return;
      err.textContent = tr("交给 agent 失败：{p1}", { p1: errText(e) });
      err.hidden = false;
    }
  }

  // -------------------------------------------------------------- 附件根目录（#251）

  private async loadAttachRoot(): Promise<void> {
    try {
      this.attachRoot = (await api.jiraAttachRoot()).root;
    } catch {
      // 问不到就当没设：面板照常能用，只是下载前会先弹选择器。
    }
  }

  /** 账号信息里的一行：路径等宽、过长省略（title 给全），右边一颗设置 / 修改。 */
  private attachRootRow(): HTMLElement {
    const line = el("div", "jira-row jira-root");
    line.append(el("span", "jira-k", tr("附件目录")));
    const root = this.attachRoot;
    const value = el("span", `jira-v${root ? " mono" : ""}`, root ?? tr("未设置"));
    if (root) value.title = root;
    const btn = el("button", "btn ghost jira-root-btn", root ? tr("修改") : tr("设置"));
    btn.onclick = () => this.openRootPicker(() => undefined);
    line.append(value, btn);
    return line;
  }

  private closePicker(): void {
    this.pickerLayer?.remove();
    this.pickerLayer = null;
  }

  /**
   * 在面板里内嵌一层目录选择（复用 dirpicker.ts，不另起 window.prompt）。
   * 选完 PUT 到桥，成功后重画面板（那一行跟着变）再回调；取消就什么都不动。
   */
  private openRootPicker(onSaved: (root: string) => void): void {
    this.closePicker();
    const layer = el("div", "jira-picker");
    layer.onclick = (ev) => {
      if (ev.target === layer) this.closePicker();
    };
    const box = el("div", "jira-picker-box");
    const head = el("div", "jira-picker-head");
    head.append(el("div", "sheet-title", this.attachRoot ? tr("换一个附件根目录") : tr("选一个附件根目录")));
    head.append(el("button", "btn ghost jira-close", "×"));
    (head.lastElementChild as HTMLButtonElement).title = tr("取消");
    (head.lastElementChild as HTMLButtonElement).setAttribute("aria-label", tr("取消"));
    (head.lastElementChild as HTMLButtonElement).onclick = () => this.closePicker();

    const hint = el("div", "jira-hint", tr("每个工单的附件落在 <根目录>/<KEY>/ 里。"));
    const body = el("div", "jira-picker-body");
    const err = el("div", "jira-note bad");
    err.hidden = true;
    const foot = el("div", "jira-picker-foot");
    const cancel = el("button", "btn ghost", tr("取消"));
    cancel.onclick = () => this.closePicker();
    const ok = el("button", "btn primary", tr("用这个目录")) as HTMLButtonElement;
    ok.disabled = true;
    foot.append(err, cancel, ok);

    let current = "";
    let picker: DirPicker | null = null;
    picker = mountDirPicker(body, {
      start: this.attachRoot ?? "",
      files: false,
      fallback: true,
      onState: (s) => {
        current = s.path;
        ok.disabled = !s.path || !!s.error;
      },
    });

    ok.onclick = () => {
      const root = current || picker?.path() || "";
      if (!root) return;
      ok.disabled = true;
      ok.textContent = tr("正在保存…");
      err.hidden = true;
      void (async () => {
        try {
          const out = await api.jiraSetAttachRoot(root);
          if (!this.root) return;
          this.attachRoot = out.root;
          this.closePicker();
          this.render();
          onSaved(out.root);
        } catch (e) {
          err.textContent = errText(e);
          err.hidden = false;
          ok.textContent = tr("用这个目录");
          ok.disabled = false;
        }
      })();
    };

    box.append(head, hint, body, foot);
    layer.append(box);
    this.root?.append(layer);
    this.pickerLayer = layer;
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
