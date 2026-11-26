/**
 * 「这台机器没有 gh / 没登录」那张卡（D428）：装在桥里，页面只负责按状态画。
 *
 * 状态机只有两档：
 * - `full`：评审现在真的用不了（没装且没 PAT / 装了没登录且没 PAT）→ 整块替换评审的 PR 格。
 * - `line`：评审已经能用（gh 就绪，或存过 PAT）→ 一行小字 + 按钮，可以「不再提示」。
 *
 * 装 / 登录 / 取消都只是发一帧，进度从 `gh.setup.event` 回来。设备码只发给发起登录的那条连接，
 * 所以这里不做任何持久化，刷新页面就当作没在登录。
 */
import { githubApi } from "./api.ts";
import { createEl as el } from "./chat.ts";
import { tr } from "./i18n/index.ts";
import "./gh-setup.css";

export interface GhInstallPlan {
  manager: string;
  text: string;
  run: { cmd: string; args: string[] } | null;
  elevated: boolean;
  url: string;
}

export interface GhSetupStatus {
  installed: boolean;
  path: string;
  version: string;
  loggedIn: boolean;
  accounts: { login: string; active: boolean }[];
  error: string;
  platform: string;
  plan: GhInstallPlan;
}

export interface GhSetupEvent {
  op: "install" | "login";
  kind: "started" | "log" | "code" | "url" | "done" | "error";
  line?: string;
  code?: string;
  url?: string;
  ok?: boolean;
  error?: string;
  status?: GhSetupStatus;
}

export interface GhCardData {
  mode: "full" | "line";
  installed: boolean;
  loggedIn: boolean;
  version: string;
  plan: GhInstallPlan;
  accounts: string[];
  log: string[];
  code: string;
  url: string;
  /** 正在跑的操作（空串 = 闲着）。 */
  op: "" | "install" | "login";
  error: string;
  patOpen: boolean;
  patBusy: boolean;
  patError: string;
  /** 已经粘进去、还没存的令牌：状态帧到了重画卡片不能把它弄丢。 */
  patDraft: string;
}

export interface GhCardActions {
  install(): void;
  login(): void;
  cancel(): void;
  refresh(): void;
  dismiss(): void;
  openPat(): void;
  closePat(): void;
  /** 输入框里的字实时回存（重画不丢）。 */
  onPatInput(token: string): void;
  savePat(token: string): void;
  openUrl(url: string): void;
}

const DISMISS_KEY = "pi.ghSetup.dismissed";
const LOG_LINES = 12;
// gh 自己的两个固定地址：桥会在事件里下发，这里只是「事件还没到」时的兜底。
const DEVICE_URL = "https://github.com/login/device";
const MANUAL_SITE = "https://cli.github.com/";

/** 桥推来的两帧（`gh.setup.status` / `gh.setup.event`）的判别联合，别用 any 接。 */
type GhSetupFrame =
  | { type: "gh.setup.status"; ok?: boolean; error?: string; setup?: GhSetupStatus | null }
  | ({ type: "gh.setup.event" } & GhSetupEvent)
  | { type?: string };

/** 记「这一档状态的卡被关掉了」；状态一变（装上 / 登录上）自动失效。 */
function dismissKey(setup: GhSetupStatus): string {
  return `${setup.installed ? 1 : 0}|${setup.loggedIn ? 1 : 0}`;
}

export class GhSetupStore {
  setup: GhSetupStatus | null = null;
  loading = false;
  op: "" | "install" | "login" = "";
  log: string[] = [];
  code = "";
  url = "";
  error = "";
  patOpen = false;
  patBusy = false;
  patError = "";
  patDraft = "";

  private send: (frame: unknown) => void;
  private onChange: () => void;
  private onPatSaved: () => void;

  constructor(
    send: (frame: unknown) => void,
    onChange: () => void,
    /** PAT 存好之后要重读账号（评审的账号下拉也跟着变）。 */
    onPatSaved: () => void,
  ) {
    this.send = send;
    this.onChange = onChange;
    this.onPatSaved = onPatSaved;
  }

  /** 只问一次；之后靠 `gh.setup.status` 帧（安装/登录完成时桥会广播）。 */
  ensure(): void {
    if (this.setup || this.loading) return;
    this.refresh();
  }

  refresh(): void {
    if (this.loading) return;
    this.loading = true;
    this.error = "";
    this.send({ type: "gh.setup.status" });
    this.onChange();
  }

  install(): void {
    if (this.op) return;
    this.op = "install";
    this.log = [];
    this.code = "";
    this.url = "";
    this.error = "";
    this.send({ type: "gh.setup.install" });
    this.onChange();
  }

  login(): void {
    if (this.op) return;
    this.op = "login";
    this.log = [];
    this.code = "";
    this.url = "";
    this.error = "";
    this.send({ type: "gh.setup.login" });
    this.onChange();
  }

  cancel(): void {
    this.send({ type: "gh.setup.cancel" });
    // 桥那边可能压根没收到（断线 / 没监听）：本地先把「正在装」放掉，
    // 否则按钮一直是「取消」，只能刷新页面（评审 #13）。
    this.op = "";
    this.onChange();
  }

  openPat(): void {
    this.patOpen = true;
    this.patError = "";
    this.onChange();
  }

  closePat(): void {
    this.patOpen = false;
    this.patError = "";
    this.patDraft = "";
    this.onChange();
  }

  onPatInput(token: string): void {
    this.patDraft = token;
  }

  async savePat(token: string): Promise<void> {
    const value = token.trim();
    if (!value || this.patBusy) return;
    this.patBusy = true;
    this.patError = "";
    this.onChange();
    try {
      await githubApi.putPat(value);
      this.patBusy = false;
      this.patOpen = false;
      this.patDraft = "";
      this.onPatSaved();
      // 先重画（按钮马上恢复），再问一次状态；万一上一次还在路上，它的帧到了也会收尾。
      this.onChange();
      this.refresh();
    } catch (err) {
      this.patBusy = false;
      // 令牌错了就是令牌错了：桥会给 401 的原文，别换成一句「保存失败」。
      this.patError = err instanceof Error ? err.message : String(err ?? "");
      this.onChange();
    }
  }

  dismiss(): void {
    if (!this.setup) return;
    try {
      localStorage.setItem(DISMISS_KEY, dismissKey(this.setup));
    } catch {
      /* 隐私模式：只影响这一次 */
    }
    this.onChange();
  }

  /** 桥推来的两帧。 */
  handle(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") return false;
    const frame = raw as GhSetupFrame;
    const type = String(frame.type ?? "");
    if (type === "gh.setup.status") {
      const msg = frame as { ok?: boolean; error?: string; setup?: GhSetupStatus | null };
      this.loading = false;
      if (msg.setup) this.setup = msg.setup;
      if (!msg.ok) this.error = String(msg.error ?? "");
      this.noteReady();
      this.onChange();
      return true;
    }
    if (type !== "gh.setup.event") return false;
    const event = frame as GhSetupEvent;
    if (event.status) this.setup = event.status;
    if (event.kind === "started") {
      this.op = event.op;
      this.log = [];
      this.code = "";
      this.url = "";
      this.error = "";
    } else if (event.kind === "log") {
      this.log = [...this.log, String(event.line ?? "")].slice(-LOG_LINES);
    } else if (event.kind === "code") {
      this.code = String(event.code ?? "");
    } else if (event.kind === "url") {
      this.url = String(event.url ?? "");
    } else if (event.kind === "done" || event.kind === "error") {
      this.op = "";
      this.error = event.kind === "error" ? String(event.error ?? tr("没有成功")) : "";
    }
    this.noteReady();
    this.onChange();
    return true;
  }

  /** 一装上 / 一登录上，「不再提示」就作废：下次真需要给提示时不能被旧的勾选吞掉。 */
  private noteReady(): void {
    if (!this.setup?.installed || !this.setup.loggedIn) return;
    try {
      localStorage.removeItem(DISMISS_KEY);
    } catch {
      /* 无所谓 */
    }
  }

  private dismissed(setup: GhSetupStatus): boolean {
    try {
      return localStorage.getItem(DISMISS_KEY) === dismissKey(setup);
    } catch {
      return false;
    }
  }

  /**
   * 给渲染层的那份数据。`patReady` = 这个会话已经有令牌（存的 PAT），评审不装 gh 也能跑。
   * `null` = 还在探测，先别画，免得每次打开面板闪一下「没装 gh」。
   */
  card(patReady: boolean): GhCardData | null {
    const setup = this.setup;
    if (!setup) return null;
    const usable = (setup.installed && setup.loggedIn) || patReady;
    if (usable && this.dismissed(setup)) return null;
    return {
      mode: usable ? "line" : "full",
      installed: setup.installed,
      loggedIn: setup.loggedIn,
      version: setup.version,
      plan: setup.plan,
      accounts: (setup.accounts ?? []).map((a) => a.login),
      log: this.log,
      code: this.code,
      url: this.url,
      op: this.op,
      error: this.error,
      patOpen: this.patOpen,
      patBusy: this.patBusy,
      patError: this.patError,
      patDraft: this.patDraft,
    };
  }
}

// ---------------------------------------------------------------- 画

function button(label: string, cls: string, onclick?: () => void): HTMLButtonElement {
  const b = el("button", `ghs-btn ${cls}`.trim(), label) as HTMLButtonElement;
  b.type = "button";
  if (onclick) b.onclick = onclick;
  return b;
}

function copyText(text: string, btn: HTMLButtonElement): void {
  const before = btn.textContent ?? "";
  let timer = 0;
  // 成功与失败都说一声：一声不响地没写进剪贴板，用户会以为按钮坏了（评审 #17）。
  const flash = (label: string) => {
    btn.textContent = label;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      btn.textContent = before;
    }, 1200);
  };
  if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).then(() => flash(tr("已复制")), () => flash(tr("复制失败")));
  else {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try {
      flash(document.execCommand("copy") ? tr("已复制") : tr("复制失败"));
    } finally {
      ta.remove();
    }
  }
}

/**
 * 一张卡。`line` 只有一行（能评但没用上 gh），`full` 是整块（评不了）。
 * 所有动作都从 `actions` 进来 —— 渲染层不认识 store，也不该认识。
 */
export function renderGhCard(data: GhCardData, actions: GhCardActions): HTMLElement {
  const box = el("div", `ghs${data.mode === "line" ? " ghs-line" : ""}`);

  const head = el("div", "ghs-head");
  if (!data.installed) {
    head.append(el("span", "ghs-title", data.mode === "line" ? tr("没装 gh：评审走内置 REST") : tr("GitHub CLI 还没就绪")));
    head.append(
      el(
        "span",
        "ghs-sub",
        data.mode === "line"
          ? tr("不装也能评；装上后 gh 的账号与命令行一起可用。")
          : tr("装上 gh 才能按账号列 PR、看详情；也可以先用一枚 PAT。"),
      ),
    );
  } else if (!data.loggedIn) {
    head.append(el("span", "ghs-title", data.mode === "line" ? tr("gh 没登录：评审用 PAT") : tr("gh 还没登录")));
    head.append(el("span", "ghs-sub", tr("浏览器里确认一次即可，不用复制令牌。")));
  } else {
    head.append(el("span", "ghs-title", tr("gh {p1} · 已登录 {p2}", { p1: data.version || "?", p2: data.accounts[0] ?? "?" })));
  }
  box.append(head);

  if (data.mode === "line" && !data.op && !data.patOpen) {
    const row = el("div", "ghs-acts");
    if (!data.installed) row.append(button(tr("装 gh"), "ghs-main", actions.install));
    if (data.installed && !data.loggedIn) row.append(button(tr("登录 gh"), "ghs-main", actions.login));
    row.append(button(tr("重新检测"), "", actions.refresh));
    row.append(button(tr("不再提示"), "ghs-quiet", actions.dismiss));
    box.append(row);
    if (data.error) box.append(el("div", "ghs-error", data.error));
    return box;
  }

  // ---- full：先把「这台机器怎么装」说清楚
  if (!data.installed) {
    if (data.plan.text) {
      const cmd = el("div", "ghs-cmdrow");
      cmd.append(el("code", "ghs-cmd", data.plan.text));
      const copy = button(tr("复制"), "ghs-quiet");
      copy.onclick = () => copyText(data.plan.text, copy);
      cmd.append(copy);
      box.append(cmd);
      if (data.plan.elevated && !data.plan.run) box.append(el("div", "ghs-hint", tr("需要管理员权限：复制到终端里执行。")));
    } else {
      box.append(el("div", "ghs-hint", tr("这台机器上没有可用的包管理器，请按官网安装。")));
    }
  }

  // ---- 一次性码
  if (data.code) {
    const code = el("div", "ghs-codebox");
    code.append(el("div", "ghs-codetext", data.code));
    const link = button(tr("打开授权页"), "ghs-main", () => actions.openUrl(data.url || DEVICE_URL));
    code.append(link);
    box.append(code);
    box.append(el("div", "ghs-hint", tr("浏览器里输入一次性码，完成后这里会自动更新。")));
  } else if (data.installed && data.op === "login") {
    box.append(el("div", "ghs-hint", tr("等待浏览器授权…")));
  }

  // ---- 进度
  if (data.op) {
    box.append(
      el(
        "div",
        "ghs-hint",
        data.op === "install" ? tr("正在装 gh…（被系统提权拦下时，去弹窗点「是」）") : tr("正在登录 gh…"),
      ),
    );
    if (data.log.length) box.append(el("pre", "ghs-log", data.log.join("\n")));
  }

  // ---- 按钮
  const acts = el("div", "ghs-acts");
  if (!data.op) {
    if (!data.installed && data.plan.run) acts.append(button(tr("装 gh"), "ghs-main", actions.install));
    if (data.installed && !data.loggedIn) acts.append(button(tr("登录 gh"), "ghs-main", actions.login));
    acts.append(button(tr("重新检测"), "", actions.refresh));
    if (data.mode === "line") acts.append(button(tr("不再提示"), "ghs-quiet", actions.dismiss));
  } else {
    acts.append(button(tr("取消"), "", actions.cancel));
  }
  if (!data.installed && !data.plan.text) {
    const site = button(tr("打开 cli.github.com"), "", () => actions.openUrl(data.plan.url || MANUAL_SITE));
    acts.append(site);
  }
  if (!data.patOpen) acts.append(button(tr("用 PAT"), "ghs-quiet", actions.openPat));
  box.append(acts);

  if (data.error) box.append(el("div", "ghs-error", data.error));

  if (data.patOpen) {
    const form = el("div", "ghs-patform");
    const input = el("input", "ghs-pat") as HTMLInputElement;
    input.type = "password";
    input.value = data.patDraft;
    input.placeholder = tr("粘贴一枚有 repo 权限的 PAT");
    // `new-password` 才是明确告诉浏览器 / 密码管理器「别当登录凭据存」的值。
    input.autocomplete = "new-password";
    input.oninput = () => actions.onPatInput(input.value);
    const save = button(tr("存"), "ghs-main", () => {
      if (!data.patBusy) actions.savePat(input.value);
    }) as HTMLButtonElement;
    if (data.patBusy) save.disabled = true;
    input.onkeydown = (ev) => {
      if (ev.key === "Enter" && !data.patBusy) actions.savePat(input.value);
    };
    if (data.patError) form.append(el("div", "ghs-error", data.patError));
    form.append(input, save);
    box.append(form);
    input.focus();
  }

  return box;
}
