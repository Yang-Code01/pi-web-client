/**
 * GitHub 面板（#661）：右侧那扇 dock，**摘要优先** —— 面板里不铺代码差异。
 *
 * 为什么是摘要：560px 的右栏里铺并排 diff 每边只剩 270px，代码会被折成两行反而更难读。所以首屏是
 * 「改了多少」（四格数字）+ 逐文件一行，想看代码点那一行去 GitHub。
 *
 * 两条边界：
 * - 凭据只在桥里。这里只看得到登录名与「PAT 存好了」。
 * - 写操作不在这里直接打 GitHub：合并那颗按钮是把一句话交给 agent（`gh pr merge`），于是它照样过
 *   `approval-gate.ts` 那道闸 —— 和终端里手敲是同一条路，不是第二条。
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
  /** 把一句话当成下一条用户消息发给当前会话（合并走这里，于是要过审批闸）。 */
  askAgent?(text: string): void;
  onClose?(): void;
}

type View = "list" | "pull";

const WIDTH_KEY = "pi.ghpW";
const MIN_W = 380;

export class GithubPanel {
  private host: GithubPanelHost;
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
    await this.reload();
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
    this.host.onClose?.();
  }

  private mount(): void {
    const root = markSurface(el("aside", "ghp"), "dock");
    root.dataset.ghp = "1";
    root.tabIndex = -1;
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    root.style.setProperty("--ghp-w", `${Number.isFinite(saved) && saved >= MIN_W ? Math.round(saved) : 560}px`);

    // 可拖的边：和预览面板同一个语言（左缘 8px 的命中带，看起来只有 3px 一道）。
    const grip = el("div", "ghp-grip");
    grip.title = tr("拖动调整宽度");
    grip.onpointerdown = (ev) => {
      ev.preventDefault();
      grip.setPointerCapture(ev.pointerId);
      root.classList.add("resizing");
      const startX = ev.clientX;
      const startW = root.getBoundingClientRect().width;
      const s = uiScale();
      const move = (e: PointerEvent) => {
        const w = Math.max(MIN_W, Math.min(window.innerWidth - 240, startW + (startX - e.clientX)));
        root.style.setProperty("--ghp-w", `${Math.round(w / s)}px`);
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        root.classList.remove("resizing");
        try {
          grip.releasePointerCapture(ev.pointerId);
        } catch {
          /* 已经松开 */
        }
        const w = parseInt(root.style.getPropertyValue("--ghp-w"), 10);
        if (w >= MIN_W) localStorage.setItem(WIDTH_KEY, String(w));
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    };

    const head = el("header", "ghp-head");
    const body = el("div", "ghp-body");
    root.append(grip, head, body);
    mountOverlay(root);
    this.root = root;
    this.head = head;
    this.body = body;
    this.esc = pushEscLayer({ el: root, focusScoped: true, onEsc: () => this.close() });
  }

  /**
   * 一次只认最后一次请求的结果：连点两个 PR 时，先发的那个回来晚不能盖掉后发的。
   * 面板外面（`github.seen` 帧）也可以叫它重读一遍。
   */
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

    const url =
      this.view === "pull" && this.detail
        ? this.detail.pull.url
        : this.state?.repo
          ? `https://github.com/${this.state.repo}/pulls`
          : "";
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

  /** 「现在是谁」常驻在标题旁：用错账号是这套东西最想消灭的失败，不能只在设置里看得见。 */
  private accountChip(): HTMLElement {
    const session = this.state?.session ?? null;
    const chip = el("button", "ghp-acct") as HTMLButtonElement;
    chip.append(el("span", "ghp-dot"), el("span", "ghp-acct-name", session ? session.login : tr("没有账号")));
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
      const pat = state?.pats?.includes(account.login) ? ` · ${tr("PAT")}` : "";
      add(`${account.login}${pat}${on ? " ✓" : ""}`, () => void this.choose(account.login), on ? "on" : "");
    }
    if (state?.session) add(tr("回到工作区默认账号"), () => void this.choose(""), "dim");
    add(tr("存一枚 PAT…"), () => this.patForm(menu), "sep");
    mountOverlay(menu);
    const r = anchor.getBoundingClientRect();
    const w = 260;
    const s = uiScale();
    menu.style.top = `${Math.round(r.bottom / s + 6)}px`;
    menu.style.left = `${Math.round(Math.max(8, (r.right - w) / s))}px`;
    this.menu = menu;
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

  /** 存 PAT：一行输入 + 保存。桥先拿它问一次 `/user`，认不出是谁就不存。 */
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
    if (!state.session) return [el("div", "ghp-hint", tr("还没有可用的 GitHub 账号：存一枚 PAT 就能看私有仓库、也能建 PR。"))];
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
    meta.append(el("span", undefined, [pr.author || "—", `${pr.head} → ${pr.base}`, ghChurn(pr.additions, pr.deletions), age ? ageText(age) : ""].filter(Boolean).join(" · ")));
    row.append(top, meta);
    row.onclick = () => {
      this.view = "pull";
      this.number = pr.number;
      this.detail = null;
      void this.reload();
    };
    return row;
  }

  /** 详情：标题 + 一行事实 + 四格数字 + 逐文件一行 + 评论露一条 + 出口。 */
  private detailCells(): HTMLElement[] {
    if (!this.detail) return [el("div", "ghp-empty", tr("正在读 PR…"))];
    const d = this.detail;
    const cells: HTMLElement[] = [];

    const hero = el("div", "ghp-hero");
    hero.append(el("h2", "ghp-hero-title", d.pull.title));
    const meta = el("div", "ghp-hero-meta");
    const age = ghAge(d.pull.updatedAt);
    const stateLabel = d.state === "open" ? tr("打开") : d.state === "merged" ? tr("已合并") : tr("已关闭");
    meta.append(
      el("span", "ghp-pill ok", stateLabel),
      el("span", undefined, d.pull.author),
      el("span", undefined, `${d.pull.head} → ${d.pull.base}`),
      age ? el("span", undefined, ageText(age)) : el("span"),
      el("span", "ghp-pill", tr("{p1}/{p2} checks", { p1: d.sample.checks.length, p2: d.sample.checks.length })),
    );
    hero.append(meta);
    if (d.body) hero.append(el("div", "ghp-hero-body", d.body));
    cells.push(hero);

    // 四格数字：这一版的核心 —— 不展开差异，也要说清改了多少。
    const stats = el("div", "ghp-stats");
    stats.append(
      statCell(tr("文件"), String(d.pull.changedFiles || d.files.length)),
      statCell(tr("新增"), `+${d.pull.additions}`, "plus"),
      statCell(tr("删除"), `−${d.pull.deletions}`, "minus"),
      statCell(tr("评论"), String(d.sample.comments.length)),
    );
    cells.push(stats);

    const files = el("section", "ghp-sec");
    const fh = el("div", "ghp-sec-head");
    fh.append(el("span", "ghp-sec-title", tr("改了哪 {p1} 个文件", { p1: d.files.length })), el("span", "ghp-sample", tr("示例数据")));
    files.append(fh);
    for (const f of d.files) {
      const row = el("button", "ghp-filestat") as HTMLButtonElement;
      row.append(
        el("span", `ghp-file-status ${f.status}`, f.status === "added" ? "A" : f.status === "removed" ? "D" : "M"),
        el("span", "ghp-file-path", f.path),
        el("span", "ghp-churn", ghChurn(f.additions, f.deletions)),
        el("span", "ghp-go", tr("在 GitHub 看 ↗")),
      );
      row.onclick = () => this.host.openExternal(`${d.pull.url}/files`);
      files.append(row);
    }
    cells.push(files);

    const comments = el("section", "ghp-sec");
    const ch = el("div", "ghp-sec-head");
    ch.append(el("span", "ghp-sec-title", tr("评论 · {p1}", { p1: d.sample.comments.length })), el("span", "ghp-sample", tr("示例数据")));
    comments.append(ch);
    const last = d.sample.comments[d.sample.comments.length - 1];
    if (last) {
      const one = el("div", "ghp-comment");
      one.append(el("div", "ghp-comment-head", `${last.author} · ${last.at}`), el("div", "ghp-comment-body", last.body));
      comments.append(one);
    }
    if (d.sample.comments.length > 1) {
      comments.append(el("div", "ghp-more", tr("还有 {p1} 条", { p1: d.sample.comments.length - 1 })));
    }
    cells.push(comments);

    const foot = el("div", "ghp-foot");
    if (d.state === "open" && this.host.askAgent) {
      const merge = el("button", "ghp-merge", tr("合并 PR")) as HTMLButtonElement;
      merge.onclick = () => {
        this.host.askAgent?.(tr("合并这个 PR：用 gh pr merge {p1} —— 先看一遍 checks 与差异，然后合并。", { p1: String(d.pull.number) }));
      };
      foot.append(merge);
    }
    const openDiff = el("button", "ghp-btn", tr("在 GitHub 看差异 ↗")) as HTMLButtonElement;
    openDiff.onclick = () => this.host.openExternal(`${d.pull.url}/files`);
    foot.append(openDiff, el("span", "ghp-foot-note", tr("合并会走审批闸")));
    cells.push(foot);
    return cells;
  }
}

function statCell(label: string, value: string, cls = ""): HTMLElement {
  const box = el("div", "ghp-stat");
  box.append(el("div", "ghp-stat-k", label), el("div", `ghp-stat-v ${cls}`.trim(), value));
  return box;
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

/** `#app` 上挂着 `zoom: var(--ui-scale)`：量到的是视觉 px，写回的是布局 px，中间要除一次（同 modal.ts）。 */
function uiScale(): number {
  const app = document.getElementById("app");
  const raw = Number.parseFloat(getComputedStyle(app ?? document.documentElement).getPropertyValue("--ui-scale"));
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}
