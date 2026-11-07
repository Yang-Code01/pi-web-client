/**
 * bug 记录里那张「⚡ AI 出错记录」页（D164）。
 *
 * 只读：正文由会话里的失败自动汇总，人只能标「已修复 / 忽略 / 删掉」。这不是洁癖 ——
 * 一旦能改正文，下一次入账就把人名下的句子覆盖了，账本也就没有可比性了。
 *
 * 左列表按「还在烧的次数」排；三个折叠区收着已修复、已忽略、被中断的，默认不占视线。
 * 右栏是这一类最后一次为什么没成、当时给的修法、以及最近几次的原文。
 */
import { createEl as el } from "./chat.ts";
import { causesOf, clock, entryState, entryTitle, failureMarkdown, ledgerMarkdown, stateLabel, type FailEntry, type FailLedger } from "./failures.ts";
import { ruleFor, ruleLine, type RuleBook, type RuleRec } from "./rules.ts";
import { tr, fmtDate, fmtTime } from "./i18n/index.ts";

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
  /** 账本边上的规矩（D164 延伸）：键与条目同一套，所以能并到同一张列表里看。 */
  private book: RuleBook | null = null;
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
    foot.append(el("span", "fail-note", tr("只读 · 由「⚡ 总结本轮错误」写入；规矩由「发到会话复盘」写回")));
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
    if (this.sel && !ledger?.entries.some((e) => e.key === this.sel) && !this.bookFor(this.sel)) this.sel = null;
    if (!this.sel && ledger?.entries.length && (!old || old.ws !== ledger.ws)) this.sel = ledger.entries[0].key;
    this.paintAll();
  }

  /** 规矩整本换：与账本同一时机（切工作区 / 桥回包）。 */
  setRules(book: RuleBook | null): void {
    this.book = book;
    this.paintAll();
  }

  private bookFor(key: string | null): RuleRec | null {
    return key ? ruleFor(this.book, key) : null;
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
    const rules = this.ruleRows();
    if (!rows.length) {
      const empty = this.query
        ? tr("没有匹配的错误。")
        : rules.length
          ? tr("账本里还没有记录。上面这些规矩是「发到会话复盘」带回来的。")
          : tr("这份账本还是空的。会话里出过错，结束时点右下角的「⚡ 总结本轮错误」。");
      // 规矩可以只来自「发到会话复盘」（人没选入账），所以账本空不等于这一页没东西。
      const nodes: HTMLElement[] = [el("div", "fail-empty", empty)];
      if (rules.length) nodes.unshift(this.rulesFold(rules));
      this.listEl.replaceChildren(...nodes);
      return;
    }
    const open = rows.filter((e) => entryState(e) === "open");
    const fixed = rows.filter((e) => entryState(e) === "fixed");
    const ignored = rows.filter((e) => entryState(e) === "ignored");
    const abort = rows.filter((e) => entryState(e) === "abort");
    const nodes: HTMLElement[] = [];
    // 规矩单独一节放在列表最上面：它是这个页面上唯一「下次有用」的东西，次数只是历史。
    if (rules.length) nodes.push(this.rulesFold(rules));
    open.forEach((e) => nodes.push(this.card(e)));
    if (!open.length) nodes.push(el("div", "fail-empty", tr("没有待修的错误。")));
    const fold = (label: string, list: FailEntry[], kind: string) => {
      if (!list.length) return;
      const d = el("details", `fail-fold ${kind}`) as HTMLDetailsElement;
      const sum = el("summary", "", label);
      const n = el("span", "n", String(list.reduce((a, e) => a + e.count, 0)));
      sum.append(n);
      d.append(sum);
      for (const e of list) d.append(this.card(e));
      nodes.push(d);
    };
    fold(tr("已修复"), fixed, "fixed");
    fold(tr("已忽略"), ignored, "ignored");
    fold(tr("已中断（不算待修）"), abort, "abort");
    this.listEl.replaceChildren(...nodes);
  }

  /** 左边那节「⚡ 规矩」：只显示有正文的；一行一条，点一下跳到它挂的那一类。 */
  private ruleRows(): RuleRec[] {
    const q = this.query;
    const all = this.book?.rules ?? [];
    if (!q) return all;
    return all.filter((r) => [r.rule, r.key, r.sig, r.tool].join(" ").toLowerCase().includes(q));
  }

  private rulesFold(list: RuleRec[]): HTMLElement {
    const d = el("details", "fail-fold rules") as HTMLDetailsElement;
    d.open = true;
    const sum = el("summary", "", tr("⚡ 规矩"));
    sum.append(el("span", "n", String(list.length)));
    d.append(sum);
    for (const r of list) {
      const row = el("div", `fail-rule-row${r.key === this.sel ? " on" : ""}`);
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.append(el("div", "fail-rule-k", r.sig || r.key), el("div", "fail-rule-t", r.rule));
      row.title = r.key;
      const pick = () => {
        this.sel = r.key;
        this.paintList();
        this.paintDetail();
      };
      row.onclick = pick;
      row.onkeydown = (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          pick();
        }
      };
      d.append(row);
    }
    return d;
  }

  /** 一张卡 = 一类：标题、次数（大字在右）、工具与最近一次的命令。密度 B，一屏 4–5 张。 */
  private card(e: FailEntry): HTMLElement {
    const card = el("div", `fail-card${e.key === this.sel ? " on" : ""}`);
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    const top = el("div", "fail-card-top");
    top.append(el("span", "fail-card-title", entryTitle(e)));
    const state = entryState(e);
    top.append(el("span", `fail-card-n${state === "open" ? " hot" : ""}`, String(e.count)));
    const sub = el("div", "fail-card-sub");
    sub.append(el("span", "", e.tool), el("span", "cmd", e.occ[0]?.cmd ?? ""), el("span", "when", clock(e.last)));
    card.append(top, sub);
    card.onclick = () => {
      this.sel = e.key;
      this.paintList();
      this.paintDetail();
    };
    card.onkeydown = (ev) => {
      if (ev.target !== card) return;
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        card.click();
      }
    };
    return card;
  }

  private paintDetail(): void {
    const e = this.ledger?.entries.find((x) => x.key === this.sel);
    const rule = this.bookFor(this.sel);
    if (!e) {
      // 账本里还没有这一类（复盘刚写下的新坑）：只把规矩摆出来，不扮出一张空条目。
      if (rule) {
        const head = el("div", "fail-dhead");
        head.append(el("div", "fail-title-big", rule.sig || rule.key));
        const meta = el("div", "fail-meta");
        meta.append(el("span", "fail-pill open", tr("未入账")), el("span", "fail-metatext", tr("这一类还没进账本，规矩先记下了")));
        this.detailEl.replaceChildren(head, meta, this.ruleBlock(rule));
        return;
      }
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
    const causes = causesOf(e);
    if (causes.length === 1) {
      const why = el("div", "fail-why");
      why.append(el("span", "fail-why-k", tr("为什么没成")), el("span", "", causes[0]));
      parts.push(why);
    } else if (causes.length > 1) {
      const why = el("div", "fail-why");
      why.append(
        el("span", "fail-why-k", tr("为什么没成")),
        el("span", "", tr("本类混了 {p1} 种原因：{p2}", { p1: causes.length, p2: causes.join(tr("；")) })),
      );
      parts.push(why);
    }
    if (e.fix) {
      const fix = el("div", "fail-why");
      fix.append(el("span", "fail-why-k", tr("当时给的修法")), el("span", "", e.fix));
      parts.push(fix);
    }
    parts.push(this.actions(e));
    if (rule) parts.push(this.ruleBlock(rule));
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

  /** 每次发生一张证据卡：谁、什么时候、跑的命令、第一行输出、exit。表格排不下长命令。 */
  private occurrences(e: FailEntry, n: number): HTMLElement {
    const box = el("div", "fail-occ");
    if (!e.occ.length) box.append(el("div", "fail-empty", tr("没有留下明细。")));
    for (const o of e.occ.slice(0, n)) {
      const ev = el("div", "fail-ev");
      const head = el("div", "fail-ev-head");
      const t = el("span", "when", clock(o.at));
      const d = new Date(o.at);
      t.title = Number.isNaN(d.getTime()) ? "" : `${fmtDate(d)} ${fmtTime(d)}`;
      head.append(t, el("span", "sess", o.name || o.sid.slice(0, 8)));
      const exit = el("span", "exit", o.exit != null ? `exit ${o.exit}` : "—");
      if (o.exit != null && o.exit !== 0) exit.classList.add("bad");
      head.append(exit);
      ev.append(head, el("div", "fail-ev-cmd", o.cmd || "—"));
      if (o.out) ev.append(el("div", "fail-ev-out", o.out));
      box.append(ev);
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

  /**
   * 「这条规矩」：一类最多一句。它由复盘轮写回（见 `rules.ts`），人只能改字、删掉 ——
   * 不能凭空新增一类规矩：没有对应失败的「规矩」只是口号，带进提示词只会占位置。
   */
  private ruleBlock(rule: RuleRec): HTMLElement {
    const box = el("div", "fail-rule");
    const head = el("div", "fail-rule-head");
    const body = el("div", "fail-rule-text", rule.rule);
    const edit = el("button", "btn ghost fail-rule-btn", tr("改")) as HTMLButtonElement;
    edit.title = tr("改这句（同样的键直接覆盖）");
    const del = el("button", "btn ghost fail-rule-btn", tr("删")) as HTMLButtonElement;
    del.title = tr("删掉这条规矩（账本里的次数不受影响）");
    del.onclick = () => this.host.send({ type: "rules.delete", ws: this.ledger?.ws ?? this.book?.ws ?? "", key: rule.key });
    edit.onclick = () => {
      const input = el("input", "fail-rule-input") as HTMLInputElement;
      input.value = rule.rule;
      const save = el("button", "btn primary fail-rule-btn", tr("保存")) as HTMLButtonElement;
      const cancel = el("button", "btn ghost fail-rule-btn", tr("取消")) as HTMLButtonElement;
      const send = () => {
        const text = input.value.trim();
        if (!text) return;
        this.host.send({ type: "rules.set", ws: this.ledger?.ws ?? this.book?.ws ?? "", key: rule.key, rule: text, sig: rule.sig, tool: rule.tool, code: rule.code });
      };
      save.onclick = send;
      cancel.onclick = () => this.paintDetail();
      input.onkeydown = (ev) => {
        if (ev.key === "Enter") send();
        if (ev.key === "Escape") this.paintDetail();
      };
      body.replaceWith(input);
      head.replaceChildren(el("span", "fail-rule-label", tr("这条规矩")), el("span", "grow"), save, cancel);
      input.focus();
      input.select();
    };
    head.append(el("span", "fail-rule-label", tr("这条规矩")), el("span", "grow"), edit, del);
    box.append(head, body);
    box.title = ruleLine(rule);
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
    a.download = tr("AI 出错记录") + "-" + new Date().toISOString().slice(0, 10) + ".md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    this.host.say(tr("已导出 {p1} 类", { p1: ledger.entries.length }));
  }
}

