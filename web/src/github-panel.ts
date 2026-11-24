/**
 * GitHub 面板：右栏那块 dock（`data-mac-surface="dock"`，层带 47 —— 压在预览 46 之上、模态 50 之下）。
 *
 * 它只做两件事：把**这个会话**的账号说清楚（谁在替你把 PR 推到哪儿），以及让 PR 在应用里就能读
 * （正文 / 文件 / 差异是真数据；checks 与评论这一版还是示例样本，页面上如实标着）。
 *
 * 两条边界：
 * - 凭据只在桥里。这里只看得到登录名与「令牌存好了」。
 * - 写操作不在这里直接打 GitHub：合并那颗按钮是把一句话交给 agent（`gh pr merge`），
 *   于是它照样过 `approval-gate.ts` 那道闸 —— 和终端里手敲是同一条路，不是第二条。
 */
import { githubApi } from "./api.ts";
import { createEl as el } from "./chat.ts";
import { ghAge, ghChurn, type GhSessionAccount, type GithubStateView, type PullDetailView, type PullRow, type PullsView } from "./github-shared.ts";
import { errText, tr } from "./i18n/index.ts";
import { markSurface, mountOverlay, pushEscLayer } from "./modal.ts";
import "./github-panel.css";

export interface GithubPanelHost {
  sessionId(): string;
  cwd(): string;
  /** 外链出口：应用里所有 https 链接都要经过宿主那一份 `safeExternalUrl`。 */
  openExternal(url: string): void;
  /** 把一句话当成下一条用户消息发给当前会话（合并 PR 走这里，于是要过审批闸）。 */
  askAgent?(text: string): void;
  onClose?(): void;
}

type View = "list" | "pull";

export class GithubPanel {
  private root: HTMLElement | null = null;
  private head: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  /** `pushEscLayer` 返回的就是「摘掉这一层」的函数。 */
  private esc: (() => void) | null = null;
  private view: View = "list";
  private repo = "";
  private number = 0;
  private state: GithubStateView | null = null;
  private detail: PullDetailView | null = null;
  private pulls: PullRow[] = [];
  private error = "";
  private busy = false;
  private seq = 0;
  private menu: HTMLElement | null = null;

  private host: GithubPanelHost;

  constructor(host: GithubPanelHost) {
    this.host = host;
  }

  get isOpen(): boolean {
    return this.root !== null;
  }

  /** 打开面板。`number` 有值就进详情，否则停在列表。 */
  async open(opts: { repo?: string; number?: number } = {}): Promise<void> {
    if (!this.root) this.mount();
    this.repo = opts.repo || this.repo;
    this.number = opts.number ?? 0;
    this.view = this.number ? "pull" : "list";
    this.error = "";
    void this.reload();
  }

  close(): void {
    if (!this.root) return;
    // 账号菜单挂在面板外面（fixed 定位），关面板时它不会跟着走。
    this.menu?.remove();
    this.menu = null;
    this.esc?.();
    this.esc = null;
    this.root.remove();
    this.root = null;
    this.head = null;
    this.body = null;
    this.menu = null;
    this.host.onClose?.();
  }

  private mount(): void {
    const root = markSurface(el("aside", "ghp"), "dock");
    root.dataset.ghp = "1";
    root.tabIndex = -1;
    const head = el("header", "ghp-head");
    const body = el("div", "ghp-body");
    root.append(head, body);
    // 挂进 `#app`（不是 body）：那里挂着 `zoom: var(--ui-scale)`，而 `--vw1` 已经按字号除过一次，
    // 挂到 body 上就少了一层缩放 —— 150% 字号下面板会比算出来的窄一截（D123 / D263）。
    mountOverlay(root);
    this.root = root;
    this.head = head;
    this.body = body;
    this.esc = pushEscLayer({ el: root, onEsc: () => this.close() });
  }

  /** 面板外面（`github.seen` 帧）也可以叫它重读一遍：一次只认最后一次结果，连点不会串。 */
  async reload(): Promise<void> {
    const seq = ++this.seq;
    this.busy = true;
    this.paint();
    const sessionId = this.host.sessionId();
    const cwd = this.host.cwd();
    try {
      const state = await githubApi.state(sessionId, cwd);
      if (seq !== this.seq) return;
      this.state = state;
      if (!this.repo && state.repo) this.repo = state.repo;
      if (this.view === "pull" && this.number) {
        this.detail = await githubApi.pull(sessionId, cwd, this.number);
        if (seq !== this.seq) return;
      } else {
        this.pulls = state.repo ? (await githubApi.pulls(sessionId, cwd)).pulls : [];
        if (seq !== this.seq) return;
      }
      this.error = "";
    } catch (err) {
      if (seq !== this.seq) return;
      this.error = errText(err);
    } finally {
      if (seq === this.seq) {
        this.busy = false;
        this.paint();
      }
    }
  }

  private paint(): void {
    if (!this.head || !this.body) return;
    this.head.replaceChildren(...this.headCells());
    this.body.replaceChildren(...this.bodyCells());
  }

  // ------------------------------------------------------------ 头部

  private headCells(): HTMLElement[] {
    const cells: HTMLElement[] = [];
    if (this.view === "pull") {
      const back = el("button", "ghp-icon ghp-back", "←") as HTMLButtonElement;
      back.title = tr("回到 PR 列表");
      back.onclick = () => {
        this.view = "list";
        this.number = 0;
        this.detail = null;
        void this.reload();
      };
      cells.push(back);
    }
    const title = el("div", "ghp-headline");
    const name = this.view === "pull" && this.detail ? `#${this.detail.pull.number}` : tr("我的 PR");
    title.append(el("span", "ghp-title", name));
    const repo = this.repo || this.state?.repo || "";
    if (repo) title.append(el("span", "ghp-repo", repo));
    cells.push(title);

    cells.push(this.accountChip());

    const url = this.view === "pull" && this.detail ? this.detail.pull.url : this.state?.repo ? `https://github.com/${this.state.repo}/pulls` : "";
    if (url) {
      const open = el("button", "ghp-open", tr("在 GitHub 打开")) as HTMLButtonElement;
      open.onclick = () => this.host.openExternal(url);
      cells.push(open);
    }
    const close = el("button", "ghp-icon ghp-close", "✕") as HTMLButtonElement;
    close.title = tr("关闭");
    close.onclick = () => this.close();
    cells.push(close);
    return cells;
  }

  /** 「现在是谁」永远在标题旁边：用错账号是这套东西最想消灭的失败，不能只在设置里看得见。 */
  private accountChip(): HTMLElement {
    const session = this.state?.session ?? null;
    const label = session ? session.login : tr("没有账号");
    const chip = el("button", "ghp-acct") as HTMLButtonElement;
    chip.append(el("span", "ghp-dot"), el("span", "ghp-acct-name", label));
    chip.title = session ? tr("会话账号：{p1}", { p1: sourceLabel(session) }) : tr("还没有可用的 GitHub 账号");
    chip.onclick = (ev) => {
      ev.stopPropagation();
      this.toggleMenu(chip);
    };
    return chip;
  }

  private toggleMenu(anchor: HTMLElement): void {
    if (this.menu) {
      this.menu.remove();
      this.menu = null;
      return;
    }
    const menu = markSurface(el("div", "ghp-menu"), "menu");
    const state = this.state;
    const add = (label: string, onClick: () => void, cls = "") => {
      const row = el("button", `ghp-menu-row ${cls}`.trim()) as HTMLButtonElement;
      row.append(el("span", "ghp-menu-label", label));
      row.onclick = () => {
        menu.remove();
        this.menu = null;
        onClick();
      };
      menu.append(row);
    };
    for (const account of state?.accounts ?? []) {
      const on = state?.session?.login === account.login;
      add(`${account.login}${account.kind === "pat" ? ` · ${tr("PAT")}` : ""}${on ? " ✓" : ""}`, () => void this.choose(account.login), on ? "on" : "");
    }
    if (state?.session) add(tr("回到工作区默认账号"), () => void this.choose(""), "dim");
    add(tr("存一枚 PAT…"), () => this.patForm(menu), "sep");
    mountOverlay(menu);
    const r = anchor.getBoundingClientRect();
    const w = 260;
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    menu.style.left = `${Math.round(Math.max(8, r.right - w))}px`;
    this.menu = menu;
    // 点外面就收；捕获阶段，免得被按钮自己的 stopPropagation 吃掉。
    const off = (ev: MouseEvent) => {
      if (menu.contains(ev.target as Node) || anchor.contains(ev.target as Node)) return;
      menu.remove();
      this.menu = null;
      document.removeEventListener("mousedown", off, true);
    };
    document.addEventListener("mousedown", off, true);
  }

  private async choose(login: string): Promise<void> {
    try {
      await githubApi.setAccount(this.host.sessionId(), login);
      await this.reload();
    } catch (err) {
      this.error = errText(err);
      this.paint();
    }
  }

  /** 存 PAT：一行输入 + 保存。桥先拿它问一次 `/user`，认不出是谁就不存（所以这里没有「可能存错了」）。 */
  private patForm(menu: HTMLElement): void {
    const form = el("div", "ghp-pat");
    const input = el("input", "ghp-pat-input") as HTMLInputElement;
    input.type = "password";
    input.placeholder = "github_pat_… / ghp_…";
    const save = el("button", "ghp-pat-save", tr("保存")) as HTMLButtonElement;
    save.onclick = async () => {
      save.disabled = true;
      try {
        const r = await githubApi.putPat(input.value.trim());
        menu.remove();
        this.menu = null;
        this.error = "";
        await this.reload();
        // 存完顺手把这个会话指到新账号上：用户点「存 PAT」的时候想的就是「用它」。
        await this.choose(r.login);
      } catch (err) {
        this.error = errText(err);
        this.paint();
      } finally {
        save.disabled = false;
      }
    };
    form.append(input, save);
    menu.append(form);
    input.focus();
  }

  // ------------------------------------------------------------ 主体

  private bodyCells(): HTMLElement[] {
    const cells: HTMLElement[] = [];
    if (this.error) cells.push(el("div", "ghp-error", this.error));
    cells.push(...this.hintCells());
    if (!this.state?.repo) {
      cells.push(el("div", "ghp-empty", tr("这个会话的目录没有 GitHub 远端（git remote get-url origin 是空的）。")));
      return cells;
    }
    if (this.view === "pull") cells.push(...this.detailCells());
    else cells.push(...this.listCells());
    return cells;
  }

  /** 降级要说清是哪一档：没装 gh / gh 没登录 / 匿名只读。三种的下一步完全不同。 */
  private hintCells(): HTMLElement[] {
    const state = this.state;
    if (!state) return [];
    if (!state.gh) return [el("div", "ghp-hint", tr("这台机器没装 gh：写操作走壳的内置实现，所以需要一枚 PAT。"))];
    if (state.ghState === "logged-out") return [el("div", "ghp-hint", tr("gh 还没登录：在终端跑 gh auth login，或者在下面存一枚 PAT。"))];
    return [];
  }

  private listCells(): HTMLElement[] {
    if (this.busy && this.pulls.length === 0) return [el("div", "ghp-empty", tr("正在读 PR…"))];
    if (this.pulls.length === 0) return [el("div", "ghp-empty", tr("这个仓库没有开着的 PR。"))];
    return this.pulls.map((pr) => this.listRow(pr));
  }

  private listRow(pr: PullRow): HTMLElement {
    const row = el("button", "ghp-row") as HTMLButtonElement;
    const top = el("div", "ghp-row-top");
    top.append(el("span", "ghp-num", `#${pr.number}`), el("span", "ghp-row-title", pr.title));
    if (pr.draft) top.append(el("span", "ghp-badge", tr("草稿")));
    const meta = el("div", "ghp-row-meta");
    const age = ghAge(pr.updatedAt);
    const parts = [pr.author || "—", `${pr.head} → ${pr.base}`, ghChurn(pr.additions, pr.deletions), age ? ageText(age) : ""].filter(Boolean);
    meta.append(el("span", undefined, parts.join(" · ")));
    row.append(top, meta);
    row.onclick = () => {
      this.view = "pull";
      this.number = pr.number;
      this.detail = null;
      void this.reload();
    };
    return row;
  }

  private detailCells(): HTMLElement[] {
    if (!this.detail) return [el("div", "ghp-empty", tr("正在读 PR…"))];
    const d = this.detail;
    const cells: HTMLElement[] = [];

    const hero = el("div", "ghp-hero");
    hero.append(el("h2", "ghp-hero-title", d.pull.title));
    const meta = el("div", "ghp-hero-meta");
    const age = ghAge(d.pull.updatedAt);
    const bits = [
      d.pull.author,
      `${d.pull.head} → ${d.pull.base}`,
      d.state === "open" ? tr("打开") : d.state === "merged" ? tr("已合并") : tr("已关闭"),
      d.pull.changedFiles ? tr("{p1} 个文件", { p1: d.pull.changedFiles }) : "",
      ghChurn(d.pull.additions, d.pull.deletions),
      age ? ageText(age) : "",
    ].filter(Boolean);
    meta.append(el("span", undefined, bits.join(" · ")));
    hero.append(meta);
    if (d.body) hero.append(el("div", "ghp-hero-body", d.body));
    cells.push(hero);

    const checks = el("section", "ghp-sec");
    const checkHead = el("div", "ghp-sec-head");
    checkHead.append(el("span", "ghp-sec-title", tr("checks")), el("span", "ghp-sample", tr("示例数据")));
    checks.append(checkHead);
    for (const c of d.sample.checks) {
      const row = el("div", `ghp-check ${c.state === "success" ? "ok" : c.state === "failure" ? "bad" : ""}`.trim());
      row.append(el("span", "ghp-check-mark", c.state === "success" ? "✓" : c.state === "failure" ? "✕" : "·"), el("span", undefined, c.name));
      checks.append(row);
    }
    cells.push(checks);

    const files = el("section", "ghp-sec");
    files.append(el("div", "ghp-sec-head", tr("改动")));
    for (const f of d.files) {
      const row = el("div", "ghp-file");
      const top = el("button", "ghp-file-top") as HTMLButtonElement;
      top.append(
        el("span", `ghp-file-status ${f.status}`, f.status === "added" ? "A" : f.status === "removed" ? "D" : "M"),
        el("span", "ghp-file-path", f.path),
        el("span", "ghp-churn", ghChurn(f.additions, f.deletions)),
      );
      const patch = el("pre", "ghp-patch");
      for (const line of (f.patch || tr("（这个文件没有文本差异）")).split("\n")) {
        const cls = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : "";
        patch.append(el("span", cls ? `ghp-line ${cls}` : "ghp-line", line));
      }
      top.onclick = () => row.classList.toggle("open");
      row.append(top, patch);
      files.append(row);
    }
    cells.push(files);

    const comments = el("section", "ghp-sec");
    const cHead = el("div", "ghp-sec-head");
    cHead.append(el("span", "ghp-sec-title", tr("评论")), el("span", "ghp-sample", tr("示例数据")));
    comments.append(cHead);
    for (const c of d.sample.comments) {
      const row = el("div", "ghp-comment");
      row.append(el("div", "ghp-comment-head", `${c.author} · ${c.at}`), el("div", "ghp-comment-body", c.body));
      comments.append(row);
    }
    cells.push(comments);

    if (d.state === "open" && this.host.askAgent) {
      const foot = el("div", "ghp-foot");
      const merge = el("button", "ghp-merge", tr("合并 PR")) as HTMLButtonElement;
      merge.onclick = () => {
        this.host.askAgent?.(tr("合并这个 PR：用 gh pr merge {p1} —— 先看一遍 checks 与差异，然后合并。", { p1: String(d.pull.number) }));
      };
      foot.append(merge, el("span", "ghp-foot-note", tr("合并会走审批闸，和终端里敲是同一条路")));
      cells.push(foot);
    }
    return cells;
  }
}

function ageText(age: { unit: "now" | "min" | "hour" | "day"; n: number }): string {
  if (age.unit === "now") return tr("刚刚");
  if (age.unit === "min") return tr("{p1} 分钟前", { p1: age.n });
  if (age.unit === "hour") return tr("{p1} 小时前", { p1: age.n });
  return tr("{p1} 天前", { p1: age.n });
}

function sourceLabel(session: GhSessionAccount): string {
  if (session.source === "session") return tr("这个会话临时选的");
  if (session.source === "project") return tr("工作区设置里定的");
  if (session.source === "global") return tr("全局设置里定的");
  if (session.source === "active") return tr("gh 的 active 账号");
  return tr("存过的那枚 PAT");
}

