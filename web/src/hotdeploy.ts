/**
 * 热部署：设置 →「工具」→ 那颗按钮打开的对话框。
 *
 * 只做一件事：选一条分支，把 7864 上的桥换成分支上那份构建。进度由 worker 写进
 * `.scratch/hot-deploy/state.json`，这里轮询 `/api/hotdeploy` 把它画出来 —— 桥被杀掉
 * 的那几十秒里轮询会连续失败，那就写「等新进程」，恢复后从 state.json 收尾。
 *
 * 版式是原型 A（单栏 880px，`.scratch/hot-deploy/prototype/a-single.html`）。
 */
import { api } from "./api.ts";
import { createEl as el } from "./chat.ts";
import type { HotdeployBranch, HotdeployRun, HotdeploySnapshot } from "./hotdeploy-types.ts";
import { errText, tr } from "./i18n/index.ts";
import "./hotdeploy.css";

/** 步骤名与 worker 的 step 序号一一对应；中文原文就是 i18n 键。 */
const STEPS = ["检查更新", "拉取所选分支", "编译前端与桥", "换进程", "健康检查"];
const POLL_MS = 1200;
/** 结束很久的老结果不该再弹出来：超过这么久就当没跑过。 */
const RESULT_TTL_MS = 10 * 60_000;

let current: HotdeployPanel | null = null;

export function openHotdeploy(): void {
  current?.close();
  current = new HotdeployPanel();
  current.mount();
}

export function closeHotdeploy(): void {
  current?.close();
}

type NoticeKind = "warn" | "err";

interface Notice {
  kind: NoticeKind;
  /** 已经翻好的句子；`acts` 里的按钮自己带处理。 */
  text: string;
  acts?: { label: string; run: () => void }[];
}

class HotdeployPanel {
  private root!: HTMLDivElement;
  private console!: HTMLElement;
  private sub!: HTMLElement;
  private nowBox!: HTMLElement;
  private branchesBox!: HTMLElement;
  private branchCap!: HTMLElement;
  private stepsBox!: HTMLElement;
  private steps: HTMLElement[] = [];
  private clock!: HTMLElement;
  private logBox!: HTMLDetailsElement;
  private logPre!: HTMLElement;
  private logCount!: HTMLElement;
  private statusBox!: HTMLElement;
  private runBtn!: HTMLButtonElement;
  private hint!: HTMLElement;

  private snap: HotdeploySnapshot | null = null;
  private selected = "";
  private poll = 0;
  private loading = false;
  private clockTimer = 0;
  private countdownTimer = 0;
  private countdown: number | null = null;
  /** 这页见过 running：只有自己看着它跑完，才自动刷新。 */
  private sawRunning = false;
  private notice: Notice | null = null;
  private forceTarget = "";
  private branchSig = "";
  private down = false;
  private closed = false;
  private lastPhase = "";
  /** 远端分支默认折起来：本地 24 条 + 远端 86 条铺开一屏就全是它了。 */
  private showRemote = false;
  private keyHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      this.close();
    }
  };

  mount(): void {
    this.root = el("div", "sys-back hot-back");
    this.root.addEventListener("mousedown", (e) => {
      if (e.target === this.root) this.close();
    });
    this.console = el("section", "sys-console hot");
    this.console.setAttribute("role", "dialog");
    this.console.setAttribute("aria-modal", "true");
    this.console.setAttribute("aria-label", tr("热部署"));
    this.build();
    this.root.append(this.console);
    document.body.append(this.root);
    document.addEventListener("keydown", this.keyHandler, true);
    document.documentElement.classList.add("hot-open");
    void this.load();
    this.poll = window.setInterval(() => void this.load(), POLL_MS);
    this.clockTimer = window.setInterval(() => this.paintClock(), 1000);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    window.clearInterval(this.poll);
    window.clearInterval(this.clockTimer);
    window.clearInterval(this.countdownTimer);
    document.removeEventListener("keydown", this.keyHandler, true);
    document.documentElement.classList.remove("hot-open");
    this.root.remove();
    if (current === this) current = null;
  }

  // ---------------------------------------------------------------- 骨架

  private build(): void {
    const head = el("header", "sys-head");
    const main = el("div", "sys-head__main");
    const eyebrow = el("div", "sys-eyebrow", tr("工具 · 本机"));
    const title = el("h2", "sys-title", tr("热部署"));
    this.sub = el("div", "sys-sub", "");
    main.append(eyebrow, title, this.sub);
    const actions = el("div", "sys-head__actions");
    const close = el("button", "btn ghost", tr("关闭")) as HTMLButtonElement;
    close.onclick = () => this.close();
    actions.append(close);
    head.append(main, actions);

    const body = el("div", "hot-body");

    this.nowBox = el("div", "hot-now");
    body.append(this.nowBox);

    const picker = el("section", "hot-block");
    this.branchCap = el("div", "hot-label");
    this.branchesBox = el("div", "hot-branches");
    picker.append(this.branchCap, this.branchesBox);

    const progress = el("section", "hot-block");
    const progressCap = el("div", "hot-label");
    progressCap.append(el("span", "", tr("进度")));
    this.clock = el("span", "hot-right hot-clock", "");
    progressCap.append(this.clock);
    this.stepsBox = el("div", "hot-steps");
    for (let i = 0; i < STEPS.length; i += 1) {
      const row = el("div", "hot-step");
      row.append(el("span", "hot-ico", ""), el("span", "hot-name", tr(STEPS[i])), el("span", "hot-info", ""));
      this.steps.push(row);
      this.stepsBox.append(row);
    }
    this.logBox = el("details", "hot-log") as HTMLDetailsElement;
    const summary = el("summary", "");
    summary.append(el("span", "hot-caret", "▸"), el("span", "", tr("日志尾")));
    this.logCount = el("span", "hot-right", "");
    summary.append(this.logCount);
    this.logPre = el("pre", "hot-log__pre", "");
    this.logBox.append(summary, this.logPre);
    this.logBox.addEventListener("toggle", () => {
      if (this.logBox.open) void this.loadLog();
    });
    progress.append(progressCap, this.stepsBox, this.logBox);
    body.append(picker, progress);

    this.statusBox = el("div", "hot-status");

    const foot = el("footer", "hot-foot");
    this.hint = el("span", "hot-hint", "");
    const grow = el("div", "hot-grow");
    this.runBtn = el("button", "btn primary hot-run", tr("热部署")) as HTMLButtonElement;
    this.runBtn.onclick = () => void this.run();
    foot.append(this.hint, grow, this.runBtn);

    this.console.append(head, body, this.statusBox, foot);
  }

  // ---------------------------------------------------------------- 数据

  private async load(): Promise<void> {
    // 一次快照要跑几条 git（本仓库 30+ worktree，实测 3–4s）；900ms 一枪会互相叠着排队。
    if (this.closed || this.loading) return;
    this.loading = true;
    try {
      const snap = await api.hotdeploy();
      this.down = false;
      this.snap = snap;
      if (!this.selected || !snap.branches.some((b) => b.name === this.selected)) {
        this.selected = snap.branch || snap.branches.find((b) => b.current)?.name || snap.branches[0]?.name || "";
      }
      this.paint();
      if (this.logBox.open) void this.loadLog();
    } catch {
      // 桥正在被换掉：继续转，等新进程
      this.down = true;
      this.paint();
    } finally {
      this.loading = false;
    }
  }

  private async loadLog(): Promise<void> {
    try {
      const { lines } = await api.hotdeployLog(160);
      if (this.closed) return;
      this.logCount.textContent = tr("{n} 行", { n: lines.length });
      this.logPre.textContent = lines.join("\n");
      this.logPre.scrollTop = this.logPre.scrollHeight;
    } catch {
      /* 桥换了就下一轮再来 */
    }
  }

  private runOf(): HotdeployRun | null {
    const run = this.snap?.run;
    if (!run || !run.phase) return null;
    if (run.phase !== "running") {
      const end = run.finishedAt ? Date.parse(run.finishedAt) : 0;
      if (!end || Date.now() - end > RESULT_TTL_MS) return null;
    }
    return run;
  }

  // ---------------------------------------------------------------- 画

  private paint(): void {
    const snap = this.snap;
    const run = this.runOf();
    const phase = run?.phase ?? "idle";
    if (phase === "running") this.sawRunning = true;
    if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      // 主检出可能被留在别的分支上：让顶栏那颗提醒就着这一刻重问一次。
      if (phase === "ok" || phase === "fail") {
        window.dispatchEvent(new CustomEvent("pi-hotdeploy-done", { detail: { phase, branch: run?.branch ?? "" } }));
      }
    }
    this.paintHead(snap, run);
    this.paintBranches(snap, phase);
    this.paintSteps(run, phase);
    this.paintStatus(run, phase);
    this.paintFoot(run, phase);
    this.paintClock();
  }

  private paintHead(snap: HotdeploySnapshot | null, run: HotdeployRun | null): void {
    this.sub.textContent = tr("部署到哪条分支，{port} 就换成那份构建 —— 前端和桥一起换。", { port: snap?.port ?? 7864 });
    this.nowBox.textContent = "";
    if (!snap) {
      this.nowBox.append(el("span", "hot-k", this.down ? tr("桥正在换掉，等新进程…") : tr("正在读本机…")));
      return;
    }
    const pair = (k: string, v: string, mono = true) => {
      this.nowBox.append(el("span", "hot-k", k), el("span", mono ? "hot-mono" : "", v), el("span", "hot-sep", ""));
    };
    pair(tr("当前部署"), snap.detached ? tr("(detached)") : snap.branch || "-");
    pair("", snap.head || "-");
    pair(tr("端口"), String(snap.port));
    this.nowBox.append(el("span", "hot-k", tr("会话")), el("span", "hot-mono", tr("{n} 个在跑", { n: snap.sessions })));
    if (this.down) this.nowBox.append(el("span", "hot-down", tr("（桥已停，等新进程）")));
    if (run?.phase === "running") this.nowBox.append(el("span", "hot-down", tr("（部署中）")));
  }

  private paintBranches(snap: HotdeploySnapshot | null, phase: string): void {
    const all = snap?.branches ?? [];
    const locals = all.filter((b) => !b.remoteOnly);
    const remotes = all.filter((b) => b.remoteOnly);
    const shown = this.showRemote ? [...locals, ...remotes] : locals;
    this.branchCap.textContent = "";
    this.branchCap.append(el("span", "", tr("部署到哪条分支")));
    this.branchCap.append(el("span", "hot-right", tr("本地 {n} · 远端 {m}", { n: locals.length, m: remotes.length })));

    const sig = `${this.showRemote ? 1 : 0}|${shown.map((b) => `${b.name}\u0000${b.sha}\u0000${b.occupiedBy ?? ""}\u0000${b.ahead}/${b.behind}`).join("\u0001")}`;
    if (sig !== this.branchSig) {
      this.branchSig = sig;
      this.branchesBox.textContent = "";
      for (const b of shown) this.branchesBox.append(this.branchRow(b));
      if (!shown.length) this.branchesBox.append(el("div", "hot-empty", tr("本地没有分支？")));
      if (remotes.length) {
        const more = el("button", "hot-more") as HTMLButtonElement;
        more.textContent = this.showRemote ? tr("收起远端分支") : tr("展开 {n} 条远端分支", { n: remotes.length });
        more.onclick = () => {
          this.showRemote = !this.showRemote;
          this.branchSig = "";
          this.paint();
        };
        this.branchesBox.append(more);
      }
    }
    for (const row of Array.from(this.branchesBox.children) as HTMLElement[]) {
      const name = row.dataset.branch ?? "";
      row.classList.toggle("sel", name === this.selected);
      row.classList.toggle("off", Boolean(row.dataset.occupied) || phase === "running");
      const btn = row.querySelector<HTMLButtonElement>("[data-kill]");
      if (btn) {
        const target = row.dataset.occupied ?? "";
        btn.textContent = this.forceTarget && this.forceTarget === target ? tr("确认强删") : tr("收掉它");
        btn.disabled = phase === "running";
      }
    }
  }

  private branchRow(b: HotdeployBranch): HTMLElement {
    const row = el("div", "hot-brow");
    row.dataset.branch = b.name;
    if (b.occupiedBy) row.dataset.occupied = b.occupiedBy;
    row.append(el("span", "hot-radio", ""));
    const mid = el("div", "hot-mid");
    const name = el("div", "hot-bname");
    name.append(el("span", "", b.name));
    if (b.current) name.append(el("span", "hot-badge now", tr("当前")));
    if (b.remoteOnly) name.append(el("span", "hot-badge", tr("只在远端")));
    if (b.occupiedBy) name.append(el("span", "hot-badge occ", tr("已被 worktree 占用")));
    if (b.ahead > 0) name.append(el("span", "hot-badge ahead", tr("领先 {n}", { n: b.ahead })));
    if (b.behind > 0) name.append(el("span", "hot-badge lag", tr("落后 {n}", { n: b.behind })));
    const meta = el("div", "hot-bmeta");
    meta.append(el("span", "", b.sha));
    if (b.occupiedBy) meta.append(el("span", "hot-path", ` · ${b.occupiedBy}`));
    mid.append(name, meta);
    row.append(mid);
    if (b.occupiedBy) {
      const kill = el("button", "btn tiny danger", tr("收掉它")) as HTMLButtonElement;
      kill.dataset.kill = b.occupiedBy;
      kill.onclick = (e) => {
        e.stopPropagation();
        void this.removeWorktree(b.occupiedBy ?? "");
      };
      row.append(kill);
    } else {
      row.append(el("span", "", ""));
    }
    row.onclick = () => {
      if (b.occupiedBy) return;
      this.selected = b.name;
      this.paint();
    };
    return row;
  }

  private paintSteps(run: HotdeployRun | null, phase: string): void {
    const step = typeof run?.step === "number" ? run.step : 0;
    const stamps = run?.stamps ?? [];
    const at = (i: number) => stamps.find((s) => s.step === i)?.at ?? 0;
    this.steps.forEach((row, i) => {
      let cls = "";
      if (phase === "running") cls = i < step ? "ok" : i === step ? "run" : "";
      else if (phase === "ok") cls = "ok";
      else if (phase === "fail") cls = i < step ? "ok" : i === step ? "fail" : "skip";
      row.className = `hot-step${cls ? ` ${cls}` : ""}`;
      const [ico, , info] = Array.from(row.children) as HTMLElement[];
      ico.textContent = cls === "ok" ? "✓" : cls === "fail" ? "✕" : cls === "run" ? "◐" : "○";
      ico.classList.toggle("hot-spin", cls === "run");
      // 每步用时：从它开工到下一步开工；最后一步算到结束时。
      const from = at(i);
      const to = at(i + 1) || (phase === "ok" || phase === "fail" ? Date.parse(run?.finishedAt ?? "") : 0);
      if (from && to && to > from && (cls === "ok" || cls === "fail")) info.textContent = `${((to - from) / 1000).toFixed(1)}s`;
      else if (cls === "fail") info.textContent = tr("退出码 {code}", { code: run?.exitCode ?? "?" });
      else info.textContent = "";
    });
  }

  private paintClock(): void {
    const run = this.runOf();
    if (!run?.startedAt) {
      this.clock.textContent = "";
      return;
    }
    if (run.phase === "running") {
      const ms = Date.now() - Date.parse(run.startedAt);
      this.clock.textContent = tr("用时 {s}s", { s: (ms / 1000).toFixed(0) });
      this.clock.classList.add("hot");
    } else {
      const ms = Date.parse(run.finishedAt ?? "") - Date.parse(run.startedAt);
      this.clock.textContent = Number.isFinite(ms) && ms > 0 ? tr("用时 {s}s", { s: (ms / 1000).toFixed(1) }) : "";
      this.clock.classList.remove("hot");
    }
  }

  private paintStatus(run: HotdeployRun | null, phase: string): void {
    this.statusBox.textContent = "";
    const banners: HTMLElement[] = [];
    if (this.notice) {
      const n = this.notice;
      const box = this.banner(n.kind);
      const body = el("div", "hot-banner__body");
      body.append(el("div", "", n.text));
      if (n.acts?.length) {
        const acts = el("div", "hot-acts");
        for (const a of n.acts) {
          const b = el("button", "btn tiny", a.label) as HTMLButtonElement;
          b.onclick = () => {
            this.notice = null;
            a.run();
          };
          acts.append(b);
        }
        body.append(acts);
      }
      box.append(body);
      banners.push(box);
    }
    if (phase === "running") {
      const box = this.banner("warn");
      box.textContent = tr("正在部署：桥会被换掉，这页稍后自己刷新。");
      banners.push(box);
    } else if (phase === "ok") {
      const box = this.banner("ok");
      const body = el("div", "hot-banner__body");
      const line = el("div", "");
      line.append(
        el("b", "", tr("已部署 {branch}", { branch: run?.branch ?? "" })),
        el("span", "hot-mono", ` · ${run?.toSha || run?.buildId || ""}`),
        el("span", "", tr(" —— {port} 上跑的就是这份构建。", { port: this.snap?.port ?? 7864 })),
      );
      const acts = el("div", "hot-acts");
      const refresh = el("button", "btn tiny primary", tr("刷新页面")) as HTMLButtonElement;
      refresh.onclick = () => window.location.reload();
      acts.append(refresh);
      if (this.countdown !== null) acts.append(el("span", "hot-count", tr("页面将在 {n} 秒后自动刷新", { n: this.countdown })));
      body.append(line, acts);
      box.append(body);
      banners.push(box);
      if (this.sawRunning && this.countdown === null) this.startCountdown();
    } else if (phase === "fail") {
      const box = this.banner("err");
      const body = el("div", "hot-banner__body");
      const stepName = tr(STEPS[Math.min(run?.step ?? 0, STEPS.length - 1)]);
      const head = el("div", "");
      head.append(el("b", "", tr("{step}失败", { step: stepName })));
      if (run?.exitCode) head.append(el("span", "", tr("（退出码 {code}）", { code: run.exitCode })));
      head.append(el("span", "", tr("。源码已在 {branch}，但 {port} 上仍是 {oldBranch} {oldSha} 的旧构建。", {
        branch: run?.branch ?? "",
        port: this.snap?.port ?? 7864,
        oldBranch: run?.fromBranch ?? "",
        oldSha: run?.fromSha ?? "",
      })));
      body.append(head);
      if (run?.error) body.append(el("pre", "hot-errpre", String(run.error).slice(-900)));
      const acts = el("div", "hot-acts");
      const logs = el("button", "btn tiny", tr("展开日志")) as HTMLButtonElement;
      logs.onclick = () => {
        this.logBox.open = true;
        this.logBox.scrollIntoView({ block: "nearest" });
        void this.loadLog();
      };
      acts.append(logs);
      if (run?.branch && run.branch !== "main") {
        const back = el("button", "btn tiny", tr("回 main")) as HTMLButtonElement;
        back.onclick = () => void this.run("main");
        acts.append(back);
      }
      body.append(acts);
      box.append(body);
      banners.push(box);
    } else {
      banners.push(this.warnBanner());
    }
    this.statusBox.classList.toggle("on", banners.length > 0);
    this.statusBox.append(...banners);
  }

  private warnBanner(): HTMLElement {
    const box = this.banner("warn");
    const n = this.snap?.sessions ?? 0;
    box.textContent = tr("会切断 {n} 个正在跑的会话（含你现在这个），部署完这页要刷新一次。", { n });
    return box;
  }

  private banner(kind: "warn" | "ok" | "err"): HTMLElement {
    return el("div", `hot-banner ${kind}`);
  }

  private paintFoot(run: HotdeployRun | null, phase: string): void {
    const snap = this.snap;
    this.hint.textContent = tr("切分支会连同 web/dist、bridge/dist 一起换");
    this.hint.classList.remove("hot-bad");
    this.runBtn.disabled = false;
    this.runBtn.classList.remove("ghost");
    if (this.down) {
      this.runBtn.disabled = true;
      this.runBtn.textContent = tr("等新进程…");
      return;
    }
    if (!snap) {
      this.runBtn.disabled = true;
      this.runBtn.textContent = tr("热部署");
      return;
    }
    if (snap.linkedWorktree) {
      this.runBtn.disabled = true;
      this.runBtn.textContent = tr("只在主检出里用");
      this.hint.textContent = tr("这个桥是从 worktree 起的（{repo}），热部署不碰它", { repo: snap.repo });
      this.hint.classList.add("hot-bad");
      return;
    }
    if (snap.dirty) {
      this.runBtn.disabled = true;
      this.runBtn.textContent = tr("先提交改动");
      this.hint.textContent = tr("主检出有未提交的改动：{files}", { files: snap.dirtyFiles.slice(0, 3).join(" · ") });
      this.hint.classList.add("hot-bad");
      return;
    }
    if (phase === "running" || snap.busy) {
      this.runBtn.disabled = true;
      this.runBtn.textContent = tr("部署中…");
      return;
    }
    const picked = snap.branches.find((b) => b.name === this.selected);
    if (!picked) {
      this.runBtn.disabled = true;
      this.runBtn.textContent = tr("选一条分支");
      return;
    }
    if (picked.occupiedBy) {
      this.runBtn.disabled = true;
      this.runBtn.textContent = tr("这条分支被占用");
      return;
    }
    this.runBtn.textContent = phase === "ok" && this.selected === run?.branch ? tr("再部署一次") : tr("热部署");
    this.runBtn.disabled = false;
  }

  // ---------------------------------------------------------------- 动作

  private startCountdown(): void {
    this.countdown = 5;
    // 不能在这里直接 paint()：这趟 paint 还没把横幅挂上去，重入会画出两条一样的。
    window.setTimeout(() => this.paint(), 0);
    this.countdownTimer = window.setInterval(() => {
      if (this.countdown === null) return;
      this.countdown -= 1;
      if (this.countdown <= 0) {
        window.clearInterval(this.countdownTimer);
        window.location.reload();
        return;
      }
      this.paint();
    }, 1000);
  }

  private async run(branch = this.selected): Promise<void> {
    if (!branch) return;
    this.notice = null;
    this.countdown = null;
    window.clearInterval(this.countdownTimer);
    this.runBtn.disabled = true;
    try {
      await api.hotdeployRun(branch);
      this.sawRunning = true;
      this.paint();
      void this.load();
    } catch (err) {
      this.notice = { kind: "err", text: errText(err) };
      this.paintStatus(this.runOf(), "fail");
      this.runBtn.disabled = false;
    }
  }

  private async removeWorktree(target: string): Promise<void> {
    const force = this.forceTarget === target;
    try {
      const out = await api.hotdeployRemoveWorktree(target, force);
      if (out.ok) {
        this.notice = { kind: "warn", text: tr("已收掉 {path}", { path: target }) };
        this.forceTarget = "";
        this.branchSig = "";
        await this.load();
        this.paint();
        return;
      }
      const why = (out.stderr || out.stdout || "").trim().slice(-600);
      if (!force) {
        this.forceTarget = target;
        this.notice = {
          kind: "err",
          text: tr("{path} 里有未提交的改动，直接删会丢东西。确认不要了再点一次「确认强删」。", { path: target }),
          acts: [{ label: tr("看 git 怎么说"), run: () => this.showDetail(why) }],
        };
      } else {
        this.notice = { kind: "err", text: tr("收 {path} 失败：{why}", { path: target, why }) };
        this.forceTarget = "";
      }
      this.paint();
    } catch (err) {
      this.notice = { kind: "err", text: errText(err) };
      this.paint();
    }
  }

  private showDetail(text: string): void {
    this.notice = { kind: "err", text: text || tr("git 没说什么") };
    this.paint();
  }
}
