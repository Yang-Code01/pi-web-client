/**
 * GitHub 面板（#661）：右侧那扇 dock，**摘要优先** —— 面板里不铺代码差异。
 *
 * 为什么是摘要：560px 的右栏里铺并排 diff 每边只剩 270px，代码会被折成两行反而更难读。所以首屏是
 * 一篇短报告（kicker → 标题 → 署名行 → 描述全文 → 文件清单 → 讨论），想看代码点一个文件去 GitHub。
 *
 * 两条边界：
 * - 凭据只在桥里。这里只看得到登录名与「PAT 存好了」。
 * - 写操作不在这里直接打 GitHub：合并那颗按钮是把一句话交给 agent（`gh pr merge`），于是它照样过
 *   `approval-gate.ts` 那道闸 —— 和终端里手敲是同一条路，不是第二条。
 */
import { githubApi } from "./api.ts";
import { createEl as el } from "./chat.ts";
import { ghAge, ghAgeText, ghChurn, type GhSessionAccount, type GithubStateView, type PullDetailView, type PullRow, type PullsView } from "./github-shared.ts";
import { errText, tr } from "./i18n/index.ts";
import { renderMarkdown } from "./md.ts";
import { appZoom, markSurface, mountOverlay, pushEscLayer } from "./modal.ts";
import "./github-panel.css";

/** 文件状态 → 清单里那枚字母（GitHub 的 A/D/R/M 口径）；不认识的状态按 M 画。 */
const FILE_LETTER: Record<string, string> = { added: "A", removed: "D", renamed: "R", modified: "M", copied: "C", changed: "M" };

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
  /** 菜单开着时挂在 document 上的那个监听；关菜单必须一起摘掉。 */
  private menuOff: (() => void) | null = null;

  constructor(host: GithubPanelHost) {
    this.host = host;
  }

  get isOpen(): boolean {
    return this.root !== null;
  }

  /** 打开面板。`number` 有值就进详情，否则停在列表。 */
  async open(opts: { repo?: string; number?: number } = {}): Promise<void> {
    if (!this.root) this.mount();
    const prevRepo = this.repo;
    this.repo = opts.repo || this.repo;
    // 换了号（或换了仓库）就得丢掉上一条的详情：否则先画出来的是上一个 PR 的标题/文件/评论，
    // 而且这次请求一失败，旧内容会一直挂在面板上（列表行那条路径一直是对的，这里是漏的）。
    const switched = (opts.number ?? 0) !== this.number || this.repo !== prevRepo;
    this.number = opts.number ?? 0;
    if (switched) this.detail = null;
    this.view = this.number ? "pull" : "list";
    this.error = "";
    await this.reload();
  }

  close(): void {
    if (!this.root) return;
    // 账号菜单挂在面板外面（fixed 定位），关面板时它不会跟着走。
    this.closeMenu();
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
      const s = appZoom();
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
        this.detail = await githubApi.pull(sessionId, cwd, this.number, this.repo || undefined);
        if (seq !== this.seq) return;
      } else {
        // 列表要跟着头部的仓库走：从别的仓库的链接卡进来时，`this.repo` 才是那个仓库，
        // 不传它就变成「头写 A 仓、内容是本仓的 PR」。
        this.pulls = this.repo || state.repo ? (await githubApi.pulls(sessionId, cwd, this.repo || undefined)).pulls : [];
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
      this.closeMenu();
      return;
    }
    const menu = markSurface(el("div", "ghp-menu"), "menu");
    const state = this.state;
    const add = (label: string, onClick: () => void, cls = "") => {
      const row = el("button", `ghp-menu-row ${cls}`.trim()) as HTMLButtonElement;
      row.append(el("span", "ghp-menu-label", label));
      row.onclick = () => {
        this.closeMenu();
        onClick();
      };
      menu.append(row);
    };
    for (const account of state?.accounts ?? []) {
      const on = state?.session?.login === account.login;
      const hasPat = state?.pats?.includes(account.login);
      add(`${account.login}${hasPat ? ` · ${tr("PAT")}` : ""}${on ? " ✓" : ""}`, () => void this.choose(account.login), on ? "on" : "");
      if (hasPat) add(tr("删掉本机存的这枚 PAT"), () => void this.dropPat(account.login), "dim sub");
    }
    if (state?.session) {
      add(tr("只在这次会话里换（不记住）"), () => void this.choose(""), "dim");
      add(tr("设为这个工作区的默认"), () => void this.rememberWorkspace(state.session!.login), "dim");
    }
    add(tr("存一枚 PAT…"), () => this.patForm(menu), "sep");
    mountOverlay(menu);
    const r = anchor.getBoundingClientRect();
    const w = 260;
    const s = appZoom();
    menu.style.top = `${Math.round(r.bottom / s + 6)}px`;
    menu.style.left = `${Math.round(Math.max(8, (r.right - w) / s))}px`;
    this.menu = menu;
    const off = (ev: MouseEvent) => {
      if (menu.contains(ev.target as Node) || anchor.contains(ev.target as Node)) return;
      this.closeMenu();
    };
    this.menuOff = () => document.removeEventListener("mousedown", off, true);
    document.addEventListener("mousedown", off, true);
  }

  /**
   * 关掉账号菜单：元素、document 上的监听、闭包一起收。
   * 只 `remove()` 元素的话监听会活到下一次 mousedown —— 反复开菜单就攒一堆同样的捕获监听。
   */
  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
    this.menuOff?.();
    this.menuOff = null;
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

  /** 把当前账号记成这个工作区的默认（写 `<cwd>/.pi/settings.json`，跟着仓库走）。 */
  private async rememberWorkspace(login: string): Promise<void> {
    try {
      await githubApi.setProjectAccount(this.host.cwd(), login);
      await this.reload();
    } catch (err) {
      this.error = errText(err);
      this.paint();
    }
  }

  private async dropPat(login: string): Promise<void> {
    try {
      await githubApi.deletePat(login);
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
        this.closeMenu();
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
    meta.append(el("span", undefined, [pr.author || "—", `${pr.head} → ${pr.base}`, ghChurn(pr.additions, pr.deletions), age ? ghAgeText(age) : ""].filter(Boolean).join(" · ")));
    row.append(top, meta);
    row.onclick = () => {
      this.view = "pull";
      this.number = pr.number;
      this.detail = null;
      void this.reload();
    };
    return row;
  }

  /**
   * 详情：一篇短报告 —— kicker、大标题、署名行、描述全文、文件清单、讨论，最后是出口。
   *
   * 为什么不是「四格数字 + 卡片」：560px 里四格数字吃掉约四分之一高度，只说了「8 文件 +226 −11」
   * 这种署名行一行能说完的事；而真正要读的描述被塞进 150px 的滚动框，正好切在半行字上。
   * 现在描述按 markdown 全文排开，文件压成两列清单，注释与讨论同一条阅读流。
   */
  private detailCells(): HTMLElement[] {
    if (!this.detail) return [el("div", "ghp-empty", tr("正在读 PR…"))];
    const d = this.detail;
    const cells: HTMLElement[] = [];

    // kicker：号、状态、checks —— 用小字一行说完，不占一张卡。
    // 判「已合并」看 `merged` 而不是 `state`：GitHub 上合并之后 state 仍是 closed，只看 state 会把
    // 每一个合掉的 PR 都说成「已关闭」。
    const stateLabel = d.merged ? tr("已合并") : d.state === "open" ? tr("打开") : tr("已关闭");
    const kicker = el("div", "ghp-kicker");
    kicker.append(el("span", "ghp-kicker-num", `#${d.pull.number}`), el("span", "ghp-kicker-sep", "·"));
    kicker.append(el("span", `ghp-kicker-state ${d.merged ? "merged" : d.state}`, stateLabel));
    // 分子是**通过**的条数：两边都填 length 永远渲染成 N/N，有失败也读起来像全绿。
    // 一个检查都没有（没开 CI 的仓库）就不画这一段 —— 「0/0 checks 通过」是一句没有信息的话。
    const checks = d.checks ?? [];
    const comments = d.comments ?? [];
    const passing = checks.filter((c) => c.state === "success").length;
    if (checks.length) {
      kicker.append(el("span", "ghp-kicker-sep", "·"));
      kicker.append(
        el("span", passing === checks.length ? "ghp-kicker-checks ok" : "ghp-kicker-checks", tr("{p1}/{p2} checks 通过", { p1: passing, p2: checks.length })),
      );
    }
    cells.push(kicker);

    cells.push(el("h2", "ghp-doc-title", d.pull.title));

    const age = ghAge(d.pull.updatedAt);
    const by = el("div", "ghp-doc-by");
    by.append(el("span", undefined, d.pull.author || "—"), el("span", "ghp-kicker-sep", "·"));
    by.append(el("code", undefined, `${d.pull.head} → ${d.pull.base}`), el("span", "ghp-kicker-sep", "·"));
    if (age) by.append(el("span", undefined, tr("{p1}更新", { p1: ghAgeText(age) })), el("span", "ghp-kicker-sep", "·"));
    by.append(el("span", "ghp-doc-churn", [tr("{p1} 个文件", { p1: d.pull.changedFiles || d.files.length }), ghChurn(d.pull.additions, d.pull.deletions)].filter(Boolean).join(" ")));
    cells.push(by, el("div", "ghp-rule"));

    if (d.body.trim()) {
      // PR 描述就是 Markdown（标题、列表、```代码）：按文档模式渲染，软换行合成段，和 GitHub 上读一样。
      const doc = el("div", "ghp-doc");
      doc.append(renderMarkdown(d.body, { doc: true }));
      cells.push(doc);
    } else {
      cells.push(el("div", "ghp-hint", tr("这个 PR 没有写描述")));
    }

    const files = el("section", "ghp-filesec");
    const fh = el("div", "ghp-h");
    fh.append(el("span", "ghp-h-t", tr("改了哪 {p1} 个文件", { p1: d.files.length })));
    files.append(fh);
    // 两列清单：文件多时不再一屏只放得下五六行。路径截断，悬浮看全名。
    const grid = el("div", "ghp-filegrid");
    for (const f of d.files) {
      const row = el("button", "ghp-frow") as HTMLButtonElement;
      row.type = "button";
      // GitHub 的文件状态 → 一枚字母。未知状态（`changed` 之类）按 M 画，不抛错也不留空。
      const letter = FILE_LETTER[f.status] ?? "M";
      row.append(
        el("span", `ghp-f-label ${f.status}`, letter),
        el("span", "ghp-f-path", f.path),
        el("span", "ghp-f-churn", ghChurn(f.additions, f.deletions)),
      );
      row.title = f.path;
      row.setAttribute("aria-label", tr("在 GitHub 看 {p1} 的差异", { p1: f.path }));
      // 锚点由桥算好（`#diff-<sha256(路径)>`）：点一行就落到**这个文件**的差异，而不是整页顶部。
      row.onclick = () => this.host.openExternal(`${d.pull.url}/files${f.anchor ? `#${f.anchor}` : ""}`);
      grid.append(row);
    }
    files.append(grid);
    cells.push(files);

    // 讨论：整串列出来（之前只露最后一条，「还有 N 条」还是死的）。一条竖线串起来，谁说的比说了什么轻。
    if (comments.length) {
      const sec = el("section", "ghp-commentsec");
      const ch = el("div", "ghp-h");
      ch.append(el("span", "ghp-h-t", tr("评论 · {p1}", { p1: comments.length })));
      sec.append(ch);
      const thread = el("div", "ghp-thread");
      for (const c of comments) {
        const when = ghAge(c.at);
        const post = el("div", "ghp-post");
        const head = el("div", "ghp-post-head");
        head.append(el("b", undefined, c.author || "—"));
        // 行内评论带上「文件:行」，一眼知道它说的是哪一处；评审意见正文没有位置，不编一个。
        if (c.path) head.append(el("span", "ghp-post-where", c.line ? `${c.path}:${c.line}` : c.path));
        if (when) head.append(el("span", undefined, ghAgeText(when)));
        const body = el("div", "ghp-post-body");
        // 评论也是 markdown（引用、代码块、列表），和描述走同一个渲染器。
        body.append(renderMarkdown(c.body));
        post.append(head, body);
        thread.append(post);
      }
      sec.append(thread);
      cells.push(sec);
    }

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

function sourceLabel(session: GhSessionAccount): string {
  if (session.source === "session") return tr("这个会话临时选的");
  if (session.source === "project") return tr("工作区设置里定的");
  if (session.source === "global") return tr("全局设置里定的");
  if (session.source === "active") return tr("gh 的 active 账号");
  return tr("存过的那枚 PAT");
}
