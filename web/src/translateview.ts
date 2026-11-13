import { createEl as el } from "./chat.ts";
import { tr } from "./i18n/index.ts";
import { renderMarkdown } from "./md.ts";
import type { TrDoc, TrJob, TrSyncResp } from "./types.ts";

/**
 * 预览里的翻译对照（D241）。这一层只管画：译文从哪来、任务进度、写回原文都归 app.ts 管，
 * 所以这里没有 fetch，只有回调。
 */

/** 语言自称：永远不翻译，名字叫 `LANGS` 才会被 i18n-check 豁免（见 web/i18n-check.mjs）。 */
const LANGS = ["中文", "English", "日本語", "한국어"];
const LANG_IDS = ["zh", "en", "ja", "ko"];

/** 目标语言；id 与桥的 `TrLang` 同一组。 */
export const TR_LANGS: { id: string; label: string }[] = LANG_IDS.map((id, i) => ({ id, label: LANGS[i] }));

export function trLangLabel(id: string): string {
  const i = LANG_IDS.indexOf(id);
  return i >= 0 ? LANGS[i] : id;
}

/**
 * 默认翻成什么：源文是日文就翻中文，是中文就翻英文，其余（英文、代码、空文）兜底翻中文 ——
 * 这个界面的使用者读中文。只数假名与汉字，够用了：猜错了用户在下拉里改一下就好。
 */
export function guessTrLang(src: string): string {
  const head = src.slice(0, 20000);
  const kana = (head.match(/[\u3040-\u30ff]/g) ?? []).length;
  const han = (head.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const letters = (head.match(/\p{L}/gu) ?? []).length || 1;
  if (kana / letters > 0.05) return "zh";
  if (han / letters > 0.2) return "en";
  return "zh";
}

export interface TrView {
  lang: string;
  doc: TrDoc | null;
  job: TrJob | null;
  /** 正在起任务 / 正在存译文：按钮先按下去不响应。 */
  busy: boolean;
  editing: boolean;
  /** 编辑中的草稿；null 表示照 doc 拼。 */
  draft: string | null;
  dirty: boolean;
  /** 源文件在译文之后改过了。 */
  stale: boolean;
  error: string;
  /** 上一次成功的动作留给人看的一句话。 */
  msg: string;
}

export interface TrAct {
  /** 还没有译文：开选择器。 */
  start(): void;
  update(force: boolean): void;
  cancel(): void;
  edit(on: boolean): void;
  save(text: string): void;
  sync(): void;
  /** 换语言 / 换模型。 */
  picker(): void;
  back(): void;
}

/** 把 doc 的译文按节拼回一整篇 —— 编辑框里给它，存的时候桥按节再切回来。 */
export function trText(doc: TrDoc | null): string {
  return doc ? doc.sections.map((s) => s.out).join("\n\n") : "";
}

function modelName(doc: TrDoc | null, job: TrJob | null): string {
  const m = job?.model || doc?.model || "";
  return m.split("/").pop() ?? m;
}

export function paintTranslate(body: HTMLElement, v: TrView, act: TrAct): void {
  body.replaceChildren();
  body.classList.add("tr-body");
  if (v.editing) body.classList.add("tr-editing");

  const running = v.job?.status === "running";
  const bar = el("div", "tr-bar");
  const chips = el("div", "tr-chips");
  chips.append(el("span", "tr-chip lang", trLangLabel(v.lang)));
  const who = modelName(v.doc, v.job);
  if (who) {
    const chip = el("span", "tr-chip model", who);
    chip.title = v.job?.provider || v.doc?.provider || "";
    chips.append(chip);
  }
  bar.append(chips);

  const status = el("div", "tr-status");
  let brief = "";
  if (v.busy) brief = tr("正在起任务…");
  else if (v.job?.status === "running") brief = tr("翻译中 {done}/{total}", { done: v.job.done, total: v.job.total || "?" });
  else if (v.job?.status === "error") brief = v.job.error || tr("翻译失败了");
  else if (v.error) brief = v.error;
  else if (v.msg) brief = v.msg;
  else if (v.stale && v.doc) brief = tr("原文改过了，点「更新」只重翻变了的节");
  else if (v.doc) {
    const n = v.doc.sections.filter((s) => s.out === s.src).length;
    brief = n ? tr("{n} 节没翻干净（原文留下了）", { n }) : tr("译文是 {p1} 生成的", { p1: modelName(v.doc, null) });
  }
  status.append(el("span", "tr-brief", brief));
  if (running && v.job?.note) {
    const note = el("span", "tr-note", v.job.note);
    note.title = v.job.note;
    status.append(note);
  }
  if (v.doc?.warnings.length) {
    const w = el("button", "tr-warn", tr("⚠ {n} 处告警", { n: v.doc.warnings.length }));
    w.title = v.doc.warnings.slice(0, 20).join("\n");
    w.onclick = () => {
      w.title = v.doc?.warnings.slice(0, 20).join("\n") ?? "";
      alert(w.title);
    };
    status.append(w);
  }
  bar.append(status);

  const tools = el("div", "tr-tools");
  const btn = (label: string, tip: string, fn: () => void, cls = ""): HTMLButtonElement => {
    const b = el("button", `btn tr-btn ${cls}`.trim(), label) as HTMLButtonElement;
    b.title = tip;
    b.onclick = fn;
    tools.append(b);
    return b;
  };
  if (running) {
    btn(tr("取消"), tr("停下这个任务，已经翻好的节留着"), () => act.cancel(), "danger");
  } else if (v.doc) {
    btn(v.editing ? tr("看对照") : tr("改译文"), tr("直接编辑译文；存了只改缓存，不碰原文"), () => act.edit(!v.editing), v.editing ? "on" : "");
    btn(tr("同步原文"), tr("把你在译文里改的地方写回原文文件（会先给你看差异）"), () => act.sync());
    btn(tr("更新"), tr("重翻：一个字没动的节跳过，只翻变了的"), () => act.update(false));
  } else {
    btn(tr("开始翻译"), tr("选语言和模型"), () => act.start(), "primary");
  }
  btn(tr("换语言"), tr("换目标语言或模型（换模型会整篇重翻）"), () => act.picker());
  btn(tr("返回预览"), tr("回到预览，译文还留着"), () => act.back());
  bar.append(tools);
  body.append(bar);

  if (v.error && !v.doc && !running) {
    body.append(el("div", "tr-msg err", v.error));
    return;
  }

  if (v.editing && v.doc) {
    mountEditor(body, v, act);
    return;
  }

  if (!v.doc) {
    const empty = el("div", "tr-empty");
    if (running) {
      empty.append(el("div", "tr-spin", "◔"), el("div", "", tr("正在翻第 {done} / {total} 节…", { done: v.job?.done ?? 0, total: v.job?.total || "?" })));
      const prog = el("div", "tr-prog");
      const fill = el("div", "tr-prog-fill");
      const pct = v.job?.total ? Math.round((v.job.done / v.job.total) * 100) : 0;
      fill.style.width = `${pct}%`;
      prog.append(fill);
      empty.append(prog);
    } else {
      empty.append(
        el("div", "", tr("还没有译文。")),
        el("div", "tr-tip", tr("翻译用一个独立的 pi 子进程跑，不占这段对话的上下文；译文存在本机，不碰源文件。")),
      );
      const go = el("button", "btn primary", tr("翻译成 {p1}", { p1: trLangLabel(v.lang) }));
      go.onclick = () => act.start();
      empty.append(go);
    }
    body.append(empty);
    return;
  }

  const cmp = el("div", "tr-cmp");
  v.doc.sections.forEach((sec, i) => {
    const row = el("div", "tr-row");
    row.dataset.sec = String(i);
    const src = el("div", "tr-src md-doc");
    src.append(renderMarkdown(sec.src, { doc: true }));
    const out = el("div", "tr-out md-doc");
    out.append(renderMarkdown(sec.out, { doc: true }));
    if (sec.out === sec.src) {
      out.classList.add("raw");
      out.title = tr("这一节没翻（模型这次没给出来），原文留下了");
    } else if (sec.out !== sec.gen) {
      out.classList.add("edited");
      const dot = el("span", "tr-dot", "✎");
      dot.title = tr("这一节你改过");
      out.append(dot);
    }
    row.append(src, out);
    cmp.append(row);
  });
  body.append(cmp);
}

function mountEditor(body: HTMLElement, v: TrView, act: TrAct): void {
  const wrap = el("div", "tr-edwrap");
  const mark = el("div", "tr-edmark", tr("改译文：标题行别删（左右靠它对位）。Ctrl+S 保存"));
  const ta = el("textarea", "tr-ed") as HTMLTextAreaElement;
  ta.value = v.draft ?? trText(v.doc);
  ta.spellcheck = false;
  ta.oninput = () => {
    v.draft = ta.value;
    v.dirty = ta.value !== trText(v.doc);
    save.classList.toggle("primary", v.dirty);
  };
  const foot = el("div", "tr-edfoot");
  const save = el("button", "btn", tr("保存译文（Ctrl+S）")) as HTMLButtonElement;
  save.onclick = () => act.save(ta.value);
  const back = el("button", "btn", tr("看对照"));
  back.onclick = () => {
    if (v.dirty && !confirm(tr("译文还没保存，放弃这些改动？"))) return;
    act.edit(false);
  };
  const hint = el("div", "tr-edmsg", v.msg);
  foot.append(save, back, hint);
  ta.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
      ev.preventDefault();
      act.save(ta.value);
    }
  });
  wrap.append(mark, ta, foot);
  body.append(wrap);
  ta.focus();
}

export interface PickerOpts {
  /** 现在用的是哪个语言 / 模型（换语言时预选）。 */
  lang: string;
  /** 默认语言：第一次打开时由源文猜。 */
  fallbackLang: string;
  /** 让 app 用自己的模型目录填这个 select（值是 `provider/id`）。 */
  fillModels(select: HTMLSelectElement, model: string): void;
  onStart(lang: string, provider: string, model: string): void;
}

/**
 * 语言 + 模型的选法：#393 的「可选便宜模型」就落在这个下拉上 —— 目录里有什么就能选什么，
 * 默认取上次用过的那个。
 */
export function openTrPicker(o: PickerOpts, mount: (node: HTMLElement) => void): void {
  const back = el("div", "choose-back");
  const box = el("div", "choose tr-pick");
  box.append(el("div", "choose-title", tr("翻译成什么？用什么翻？")));
  let lang = o.lang || o.fallbackLang;

  const langRow = el("div", "tr-langs");
  const paints: (() => void)[] = [];
  for (const l of TR_LANGS) {
    const b = el("button", "tr-langbtn", l.label) as HTMLButtonElement;
    paints.push(() => b.classList.toggle("on", l.id === lang));
    b.onclick = () => {
      lang = l.id;
      for (const p of paints) p();
    };
    langRow.append(b);
  }
  box.append(langRow);

  const sel = el("select", "tr-modelsel") as HTMLSelectElement;
  sel.onchange = () => {
    try {
      localStorage.setItem("pi.trModel", sel.value);
    } catch {
      /* 隐私模式：记不住就算了 */
    }
  };
  o.fillModels(sel, "");
  box.append(sel);

  box.append(el("div", "tr-tip", tr("默认用一个便宜的模型就够了：翻文档不需要最强的那个。译文只存在本机。")));

  const row = el("div", "choose-row");
  const go = el("button", "btn primary", tr("开始")) as HTMLButtonElement;
  const close = (): void => {
    document.removeEventListener("keydown", onKey, true);
    back.remove();
  };
  go.onclick = () => {
    const [provider, ...rest] = sel.value.split("/");
    const model = rest.join("/");
    if (!provider || !model) return;
    close();
    o.onStart(lang, provider, model);
  };
  const cancel = el("button", "btn", tr("取消"));
  cancel.onclick = close;
  row.append(go, cancel);
  box.append(row);

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  back.onclick = (ev) => {
    if (ev.target === back) close();
  };
  back.append(box);
  paintAll();
  mount(back);

  function paintAll(): void {
    for (const p of paints) p();
  }
}

/** 写回原文之前的确认：只列改动的块，`-` 是原文、`+` 是要写进去的。 */
export function openSyncReview(
  r: TrSyncResp,
  path: string,
  onApply: () => void,
  mount: (node: HTMLElement) => void,
): void {
  const back = el("div", "choose-back");
  const box = el("div", "choose tr-review");
  box.append(el("div", "choose-title", tr("把 {n} 处改动写回原文？", { n: r.edits })));
  box.append(el("div", "tr-tip", path));
  const list = el("div", "tr-diffs");
  for (const p of r.preview) {
    const one = el("div", "tr-diff");
    const d = el("pre", "del", p.before);
    const a = el("pre", "ins", p.after);
    one.append(d, a);
    list.append(one);
  }
  if (!r.preview.length) list.append(el("div", "tr-tip", tr("（没有可预览的差异）")));
  box.append(list);
  if (r.missing) box.append(el("div", "tr-tip", tr("{n} 处没找到对应位置，跳过了", { n: r.missing })));
  for (const w of r.warnings.slice(0, 6)) box.append(el("div", "tr-tip", w));
  box.append(el("div", "tr-tip", tr("写回前会把原文备份到状态目录，后悔了能捞回来。")));
  const row = el("div", "choose-row");
  const ok = el("button", "btn primary", tr("写回原文")) as HTMLButtonElement;
  const close = (): void => {
    document.removeEventListener("keydown", onKey, true);
    back.remove();
  };
  ok.onclick = () => {
    close();
    onApply();
  };
  const no = el("button", "btn", tr("取消"));
  no.onclick = close;
  row.append(ok, no);
  box.append(row);
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  back.onclick = (ev) => {
    if (ev.target === back) close();
  };
  back.append(box);
  mount(back);
}
