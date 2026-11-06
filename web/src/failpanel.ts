/**
 * bug 记录里那张「⚡ AI 出错记录」页（D160）。
 *
 * 只读：正文由会话里的失败自动汇总，人只能标「已修复 / 忽略 / 删掉」。这不是洁癖 ——
 * 一旦能改正文，下一次入账就把人名下的句子覆盖了，账本也就没有可比性了。
 *
 * 左列表按「还在烧的次数」排；三个折叠区收着已修复、已忽略、被中断的，默认不占视线。
 * 右栏是这一类最后一次为什么没成、当时给的修法、以及最近几次的原文。
 */
import { createEl as el } from "./chat.ts";
import { clock, codeLabel, entryState, entryTitle, failureMarkdown, ledgerMarkdown, ripeEntries, stateLabel, type FailEntry, type FailLedger } from "./failures.ts";
import { tr } from "./i18n/index.ts";

export interface FailHost {
  send(msg: unknown): void;
  handoff(anchor: HTMLElement, text: string): void;
  say(text: string, bad?: boolean): void;
}

const SHOW_OCC = 3;

export class FailPanel {
  private readonly host: FailHost;
  private root!: HTMLElement;
  private listEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private statEl!: HTMLElement;

  private ledger: FailLedger | null = null;
  private sel: string | null = null;
  private query = "";
  private allOcc = new Set<string>();

  constructor(host: FailHost) {
    this.host = host;
    this.build();
  }

  private build(): void {
    const body = el("div", "fail-body");

    const side = el("div", "fail-side");
    const head = el("div", "fail-ws");
    const name = el("div", "fail-ws-name", "");
    this.statEl = el("div", "fail-ws-stat", "");
    head.append(name, this.statEl);
    name.dataset.role = "wsname";
    const search = el("input", "fail-search") as HTMLInputElement;
    search.type = "search";
    search.placeholder = tr("搜类型 / 命令 / 输出");
    search.oninput = () => {
      this.query = search.value.trim().toLowerCase();
      this.paintList();
    };
    this.searchEl = search;
    this.listEl = el("div", "fail-list");
    side.append(head, search, this.listEl);

    this.detailEl = el("div", "fail-detail");
    body.append(side, this.detailEl);

    const foot = el("div", "fail-foot");
    foot.append(el("span", "fail-note", tr("只读 · 由「⚡ 总结本轮错误」写入，同一类再犯只加次数")));
    const exp = el("button", "btn ghost", tr("导出这份账本"));
    exp.onclick = () => this.exportAll();
    foot.append(exp);
    body.append(foot);

    this.root = body;
    this.paintAll();
  }

  mount(parent: HTMLElement): void {
    parent.append(this.root);
  }

  /** 切到这一页时把光标放检索框里（跟记录页「打开就能写」同一个手势）。 */
  focus(): void {
    this.searchEl.focus();
  }

  setLedger(ledger: FailLedger | null): void {
    const old = this.ledger;
    this.ledger = ledger;
    // 同一份账本、只是多了次数：保持选中，别把人正在看的那类弹走。
    if (this.sel && !ledger?.entries.some((e) => e.key === this.sel)) this.sel = null;
    if (!this.sel && ledger?.entries.length && (!old || old.ws !== ledger.ws)) this.sel = ledger.entries[0].key;
    this.paintAll();
  }

  private get label(): string {
    return this.ledger?.label || this.ledger?.ws || "";
  }

  private rows(): FailEntry[] {
    const q = this.query;
    const all = this.ledger?.entries ?? [];
    return all.filter((e) => {
      if (!q) return true;
      return [entryTitle(e), e.code, e.tool, e.sig, e.why, e.fix, ...e.occ.map((o) => `${o.cmd} ${o.out}`)].join(" ").toLowerCase().includes(q);
    });
  }

  private paintAll(): void {
    this.paintHead();
    this.paintList();
    this.paintDetail();
  }

  private paintHead(): void {
    const name = this.root.querySelector<HTMLElement>('[data-role="wsname"]');
    if (name) name.textContent = this.label || tr("当前工作区");
    const all = this.ledger?.entries ?? [];
    const total = all.reduce((n, e) => n + e.count, 0);
    this.statEl.textContent = all.length ? tr("{p1} 类 · {p2} 次", { p1: all.length, p2: total }) : "";
    this.statEl.title = this.ledger?.ws ?? "";
  }

  private paintList(): void {
    const rows = this.rows();
    if (!rows.length) {
      const empty = this.query
        ? tr("没有匹配的错误。")
        : tr("这份账本还是空的。会话里出过错，结束时点右下角的「⚡ 总结本轮错误」。");
      this.listEl.replaceChildren(el("div", "fail-empty", empty));
      return;
    }
    const open = rows.filter((e) => entryState(e) === "open");
    const fixed = rows.filter((e) => entryState(e) === "fixed");
    const ignored = rows.filter((e) => entryState(e) === "ignored");
    const abort = rows.filter((e) => entryState(e) === "abort");
    const nodes: HTMLElement[] = [];
    open.forEach((e, i) => nodes.push(this.row(e, i + 1)));
    if (!open.length) nodes.push(el("div", "fail-empty", tr("没有待修的错误。")));
    const fold = (label: string, list: FailEntry[], kind: string) => {
      if (!list.length) return;
      const d = el("details", `fail-fold ${kind}`) as HTMLDetailsElement;
      const sum = el("summary", "", label);
      const n = el("span", "n", String(list.reduce((a, e) => a + e.count, 0)));
      sum.append(n);
      d.append(sum);
      for (const e of list) d.append(this.row(e, 0));
      nodes.push(d);
    };
    fold(tr("已修复"), fixed, "fixed");
    fold(tr("已忽略"), ignored, "ignored");
    fold(tr("已中断（不算待修）"), abort, "abort");
    this.listEl.replaceChildren(...nodes);
  }

  private row(e: FailEntry, rank: number): HTMLElement {
    const row = el("div", `fail-row${e.key === this.sel ? " on" : ""}`);
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    const main = el("div", "fail-main");
    main.append(el("div", "fail-title", entryTitle(e)));
    const sub = el("div", "fail-sub");
    sub.append(el("span", "", e.tool), el("span", "cmd", e.occ[0]?.cmd ?? ""), el("span", "when", clock(e.last)));
    main.append(sub);
    const state = entryState(e);
    row.append(el("span", "fail-rank", rank ? String(rank) : ""), main, el("span", `fail-count${state === "open" ? " hot" : ""}`, String(e.count)));
    row.onclick = () => {
      this.sel = e.key;
      this.paintList();
      this.paintDetail();
    };
    row.onkeydown = (ev) => {
      if (ev.target !== row) return;
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        row.click();
      }
    };
    return row;
  }

  private paintDetail(): void {
    const e = this.ledger?.entries.find((x) => x.key === this.sel);
    if (!e) {
      this.detailEl.replaceChildren(el("div", "fail-empty", this.ledger?.entries.length ? tr("左边选一类，看它为什么没成。") : ""));
      return;
    }
    const head = el("div", "fail-dhead");
    head.append(el("div", "fail-title-big", entryTitle(e)), el("div", "fail-count-big", tr("{p1} 次", { p1: e.count })));
    const meta = el("div", "fail-meta");
    meta.append(el("span", `fail-pill ${entryState(e)}`, stateLabel(e)));
    meta.append(
      el(
        "span",
        "fail-metatext",
        [e.tool, e.code, this.ledger?.label || "", tr("首次 {p1}", { p1: clock(e.first) }), tr("最近 {p1}", { p1: clock(e.last) })].filter(Boolean).join(" · "),
      ),
    );
    const parts: HTMLElement[] = [head, meta];
    if (e.why) {
      const why = el("div", "fail-why");
      why.append(el("span", "fail-why-k", tr("为什么没成")), el("span", "", e.why));
      parts.push(why);
    }
    if (e.fix) {
      const fix = el("div", "fail-why");
      fix.append(el("span", "fail-why-k", tr("当时给的修法")), el("span", "", e.fix));
      parts.push(fix);
    }
    parts.push(this.actions(e));
    parts.push(el("div", "fail-sechead", tr("发生过 {p1} 次 · 显示最近 {p2} 条", { p1: e.count, p2: Math.min(SHOW_OCC, e.occ.length) })));
    parts.push(this.occurrences(e, this.allOcc.has(e.key) ? e.occ.length : SHOW_OCC));
    if (e.occ.length > SHOW_OCC && !this.allOcc.has(e.key)) {
      const more = el("button", "btn ghost fail-more", tr("查看全部 {p1} 条", { p1: e.occ.length }));
      more.onclick = () => {
        this.allOcc.add(e.key);
        this.paintDetail();
      };
      parts.push(more);
    }
    this.detailEl.replaceChildren(...parts);
  }

  private occurrences(e: FailEntry, n: number): HTMLElement {
    const box = el("div", "fail-occ");
    const head = el("div", "fail-occ-head");
    head.append(el("span", "", tr("时间")), el("span", "", tr("会话")), el("span", "cmd", tr("命令")), el("span", "right", tr("结果")));
    box.append(head);
    if (!e.occ.length) box.append(el("div", "fail-empty", tr("没有留下明细。")));
    for (const o of e.occ.slice(0, n)) {
      const row = el("div", "fail-occ-row");
      const t = el("span", "", clock(o.at));
      t.title = new Date(o.at).toLocaleString();
      row.append(t, el("span", "sess", o.name || o.sid.slice(0, 8)), el("span", "cmd", o.cmd || "—"));
      row.append(el("span", `right ${o.exit === 0 ? "" : "bad"}`, o.exit != null ? `exit ${o.exit}` : "—"));
      box.append(row);
      if (o.out) box.append(el("div", "fail-occ-out", o.out));
    }
    return box;
  }

  private actions(e: FailEntry): HTMLElement {
    const box = el("div", "fail-actions");
    const act = (label: string, action: string, cls = "btn ghost"): HTMLButtonElement => {
      const b = el("button", cls, label);
      b.onclick = () => this.host.send({ type: "failures.act", ws: this.ledger?.ws ?? "", key: e.key, action });
      return b;
    };
    const state = entryState(e);
    if (state === "fixed") box.append(act(tr("撤销「已修复」"), "unfixed"));
    else if (state !== "ignored") box.append(act(tr("标为已修复"), "fixed"));
    if (state === "ignored") box.append(act(tr("取消忽略"), "unignore"));
    else box.append(act(tr("忽略这类"), "ignore"));
    box.append(act(tr("删除"), "delete", "btn danger"));
    const hand = el("button", "btn primary fail-hand", tr("交给 agent") + " ▾");
    hand.onclick = () => this.host.handoff(hand, failureMarkdown(e, this.label));
    box.append(el("span", "grow"), hand);
    return box;
  }

  exportAll(): void {
    const ledger = this.ledger;
    if (!ledger?.entries.length) {
      this.host.say(tr("这份账本还是空的"), true);
      return;
    }
    const blob = new Blob([ledgerMarkdown(ledger, this.label)], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = tr("AI出错记录") + "-" + new Date().toISOString().slice(0, 10) + ".md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    this.host.say(tr("已导出 {p1} 类", { p1: ledger.entries.length }));
  }
}

export { ripeEntries, codeLabel };
