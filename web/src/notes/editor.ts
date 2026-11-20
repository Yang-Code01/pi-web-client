/**
 * #486 富文本编辑器：一个 contenteditable + 一根工具栏。
 *
 * 从记录面板里拆出来的原因：这里全是 DOM 行为（选区、粘贴、```、Alt+P），要能被浏览器测试单独
 * 挂起来验，而不是必须先开一整个面板、再点开一条记录。
 *
 * 取舍（见 #486）：粗斜下删列表用 `document.execCommand` —— 它在 Chrome 里还是唯一能同时把
 * 选区、撤销栈、光标位置都处理对的现成手段；颜色 / 底色 / 字号是自写的 `span[style]` 包裹，
 * 因为 execCommand 那几条会产出 `font[color]`、`background-color` 内联到块上，净化白名单不收。
 */
import { tr } from "../i18n/index.ts";
import { matchBlock, matchInline, type BlockHit } from "../md-input.ts";
import { fenceLanguage, hasAnyStructure, sanitizeRich, textToRich } from "./rich.ts";

const SIZES: [string, string][] = [
  ["1em", "正常"],
  ["1.15em", "稍大"],
  ["1.3em", "大"],
  ["1.5em", "更大"],
  ["1.75em", "很大"],
  ["2em", "最大"],
];

const COLORS = [
  "#e5484d",
  "#f76b15",
  "#ffb224",
  "#30a46c",
  "#0ea5e9",
  "#3e63dd",
  "#8e4ec6",
  "#e93d82",
  "#8b8d98",
  "#f5f5f5",
];

export interface RichEditorOptions {
  /** `contenteditable` 的正文元素（已经在 DOM 里）。 */
  body: HTMLElement;
  /** 工具栏要画进这里。 */
  toolbar: HTMLElement;
  /** 正文被改动了（写回 model、标未保存）。 */
  onChange: () => void;
  /** 给用户一句提示（选不中文字、不能做之类的）。 */
  say?: (text: string, bad?: boolean) => void;
  /** 粘贴进来的文件（截图）。正文里不塞图片，交给面板当附件存。 */
  onFiles?: (files: File[]) => void;
  /** 只画这些工具（不传 = 全套）。id 见 `buildToolbar()`。 */
  tools?: string[];
  /** 普通段落里按回车：调用方接管（内网通用来发送）。列表 / 引用 / 代码块里仍续块。 */
  onEnter?: () => void;
}

export class RichEditor {
  private readonly body: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly onChange: () => void;
  private readonly say: (text: string, bad?: boolean) => void;
  private readonly onFiles: ((files: File[]) => void) | null;
  private readonly tools: Set<string> | null;
  private readonly onEnter: (() => void) | null;
  /** 块级替换的一次性撤销：原生撤销栈不认 `replaceWith`，转换后立刻 Ctrl+Z 由这里接管。 */
  private undo: { parent: Node; next: Node | null; original: Element; created: Element[] } | null = null;
  private savedRange: Range | null = null;
  /** IME 正在组字：这段期间 DOM 里放的是预编辑串（拼音），不是已上屏的正文。 */
  private composing = false;
  /** 最后一次已上屏的内容快照：组字期间 `html()` 返回它，自动保存不会把拼音写进正文。 */
  private committedHtml = "";
  private pop: HTMLElement | null = null;
  private readonly onOutside = (ev: MouseEvent): void => {
    const t = ev.target;
    if (!(t instanceof Node)) return;
    if (this.pop && !this.pop.contains(t) && !this.toolbar.contains(t)) this.closePop();
  };
  private readonly onDocKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape" && this.pop) {
      ev.preventDefault();
      // 面板自己也听 Esc（关整个面板）：先把这一下吃掉，别一按就把面板带走。
      ev.stopPropagation();
      this.closePop();
    }
  };

  constructor(opts: RichEditorOptions) {
    this.body = opts.body;
    this.toolbar = opts.toolbar;
    this.onChange = opts.onChange;
    this.onFiles = opts.onFiles ?? null;
    this.tools = opts.tools ? new Set(opts.tools) : null;
    this.onEnter = opts.onEnter ?? null;
    this.say = opts.say ?? (() => {});
    this.body.setAttribute("contenteditable", "true");
    this.body.spellcheck = false;
    this.body.classList.add("rich");
    this.body.addEventListener("input", (ev) => this.onInput(ev));
    this.body.addEventListener("keydown", (ev) => this.onKeydown(ev));
    this.body.addEventListener("keyup", () => this.saveRange());
    this.body.addEventListener("mouseup", () => this.saveRange());
    this.body.addEventListener("blur", () => this.saveRange());
    this.body.addEventListener("paste", (ev) => this.onPaste(ev));
    // Chrome 的 IME：组字期间的 input 全是 isComposing，compositionend 之后不再派发 input。
    // 不在 compositionend 补一次 onChange，上屏的最后几个字就永远没人通知（自动保存拿到的是旧内容）。
    this.body.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    this.body.addEventListener("compositionend", () => this.endComposition());
    this.buildToolbar();
    // 空正文也得有个段落：contenteditable 直接打字会落成裸文本节点，块级规则就找不到 block 了。
    this.ensureBlock();
    this.committedHtml = this.readHtml();
    document.addEventListener("mousedown", this.onOutside, true);
    document.addEventListener("keydown", this.onDocKey, true);
  }

  /** 换一条记录：直接换 HTML（进门前已经净化过）。 */
  setHtml(html: string): void {
    this.body.replaceChildren(parseHtml(sanitizeRich(html)));
    this.ensureBlock();
    this.composing = false;
    this.committedHtml = this.readHtml();
    this.savedRange = null;
    this.closePop();
  }

  /** 读回当前正文（净化过）。组字期间给上一次已上屏的内容：预编辑串不能当正文存。 */
  html(): string {
    return this.composing ? this.committedHtml : this.readHtml();
  }

  /** 实时 DOM 的正文（净化过）；组字期间不要从这里往外读。 */
  private readHtml(): string {
    return sanitizeRich(this.body.innerHTML);
  }

  focus(): void {
    this.body.focus();
    const range = document.createRange();
    range.selectNodeContents(this.body);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  destroy(): void {
    document.removeEventListener("mousedown", this.onOutside, true);
    document.removeEventListener("keydown", this.onDocKey, true);
    this.closePop();
  }

  // ---------------------------------------------------------------- 选区

  private saveRange(): void {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && this.body.contains(sel.anchorNode)) this.savedRange = sel.getRangeAt(0).cloneRange();
  }

  /** 活选区优先；焦点被工具栏抢走时才回退到上次存的，而且那个节点还必须在文档里。 */
  private range(): Range | null {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const live = sel.getRangeAt(0);
      if (this.body.contains(live.startContainer)) return live;
    }
    const saved = this.savedRange;
    if (saved && this.body.contains(saved.startContainer)) return saved;
    return null;
  }

  private restore(range: Range): void {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    this.savedRange = range.cloneRange();
    this.body.focus();
  }

  private exec(command: string, value?: string): void {
    this.body.focus();
    const range = this.range();
    if (range) this.restore(range);
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand(command, false, value);
    this.saveRange();
    this.notify();
  }

  // ---------------------------------------------------------------- 输入

  private afterInput(): void {
    this.ensureBlock();
    this.saveRange();
    this.notify();
  }

  /** 组字结束：DOM 已经换成上屏的字，补一次变更通知（Chrome 之后不会再派发 input）。 */
  private endComposition(): void {
    this.composing = false;
    this.afterInput();
  }

  /** 统一的「正文变了」出口：先固化已上屏快照，再回报面板。 */
  private notify(): void {
    if (!this.composing) this.committedHtml = this.readHtml();
    this.onChange();
  }

  /** 正文里连一个元素都没有时补一个空段落（光标已经在了就放到段尾）。 */
  private ensureBlock(): void {
    if (this.body.children.length) return;
    const p = document.createElement("p");
    p.append(document.createElement("br"));
    this.body.replaceChildren(p);
    if (this.body === document.activeElement) this.caretToEnd(p);
  }

  /**
   * 输入后先看要不要转 Markdown（#511）：空格试块级，闭符号试行内。
   * 转换本身不再触发一次 `onChange`——统一在末尾 `afterInput()` 里做。
   */
  private onInput(ev: Event): void {
    const ie = ev as InputEvent;
    if (ie.isComposing) return;
    // 用户又敲了别的东西：刚才那一步块级转换就不再是「最后一步」，撤销交还原生。
    this.undo = null;
    if (ie.inputType === "insertText" && ie.data) {
      if (ie.data === " ") this.tryBlock();
      else if (ie.data.length === 1 && "`*~)".includes(ie.data)) this.tryInline();
    }
    this.afterInput();
  }

  private tryBlock(): void {
    const range = this.range();
    if (!range || !range.collapsed) return;
    const block = this.topBlock(range.startContainer);
    // 裸文本节点 / 整个 body 都不当 block：块级替换必须落在一个段落上。
    if (!block || block === this.body || !(block instanceof HTMLElement) || block.tagName === "PRE") return;
    const caret = textOffset(block, range.startContainer, range.startOffset);
    if (caret === null) return;
    // contenteditable 把行尾空格存成 &nbsp;：判定前统一回普通空格（长度不变，偏移还能用）。
    const text = (block.textContent ?? "").replace(/\u00a0/g, " ");
    const hit = matchBlock(text, caret);
    if (hit) this.replaceWithBlock(block, hit);
  }

  private replaceWithBlock(block: HTMLElement, hit: BlockHit): void {
    const original = block.cloneNode(true) as HTMLElement;
    this.dropPrefix(block, hit.marker);
    let target: HTMLElement;
    let created: HTMLElement;
    if (hit.kind === "ul" || hit.kind === "ol") {
      const list = document.createElement(hit.kind);
      const li = document.createElement("li");
      list.append(li);
      target = li;
      created = list;
    } else {
      target = document.createElement(hit.kind);
      created = target;
    }
    while (block.firstChild) target.append(block.firstChild);
    if (!target.firstChild) target.append(document.createElement("br"));
    const parent = block.parentNode;
    block.replaceWith(created);
    if (parent) this.undo = { parent, next: created.nextSibling, original, created: [created] };
    this.caretToEnd(target);
  }

  /** 把段落开头 `count` 个字符删掉（标记可能跨多个文本节点）。 */
  private dropPrefix(block: Element, count: number): void {
    let left = count;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    for (const t of texts) {
      if (left <= 0) break;
      const take = Math.min(left, t.data.length);
      t.data = t.data.slice(take);
      left -= take;
    }
  }

  private tryInline(): void {
    const range = this.range();
    if (!range || !range.collapsed) return;
    const block = this.topBlock(range.startContainer);
    if (!block || !(block instanceof HTMLElement) || block.tagName === "PRE") return;
    if (this.inCode(range.startContainer, block)) return;
    const caret = textOffset(block, range.startContainer, range.startOffset);
    if (caret === null) return;
    const hit = matchInline(block.textContent ?? "", caret);
    if (!hit) return;
    const target = document.createRange();
    if (!rangeAtOffsets(block, target, hit.from, hit.to)) return;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(target);
    document.execCommand("insertHTML", false, hit.html);
  }

  private inCode(node: Node, block: Element): boolean {
    let cur: Node | null = node;
    while (cur && cur !== block) {
      if (cur instanceof HTMLElement && cur.tagName === "CODE") return true;
      cur = cur.parentNode;
    }
    return false;
  }

  private topBlock(node: Node): Element | null {
    let el: Node | null = node;
    while (el && el.parentNode !== this.body) el = el.parentNode;
    return el instanceof Element ? el : null;
  }

  private caretBlock(): HTMLElement | null {
    const range = this.range();
    if (!range) return null;
    const block = this.topBlock(range.startContainer);
    return block instanceof HTMLElement ? block : null;
  }

  private caretToEnd(node: Element): void {
    const caret = document.createRange();
    caret.selectNodeContents(node);
    caret.collapse(false);
    this.restore(caret);
  }

  private restoreUndo(): void {
    const u = this.undo;
    this.undo = null;
    if (!u || !u.created.every((n) => n.isConnected)) return;
    const clone = u.original.cloneNode(true) as Element;
    for (const n of u.created) n.remove();
    const anchor = u.next && u.next.parentNode === u.parent ? u.next : null;
    u.parent.insertBefore(clone, anchor);
    this.caretToEnd(clone);
    this.notify();
  }

  /** 光标所在块如果整行就是 ``` / ```ts，返回语言（可能为空串）；否则 null。 */
  private fenceAtCaret(): string | null {
    const range = this.range();
    if (!range || !range.collapsed) return null;
    let node: Node | null = range.startContainer;
    while (node && node.parentNode !== this.body) node = node.parentNode;
    if (!node || !(node instanceof HTMLElement)) return null;
    if (node.tagName === "PRE") return null;
    return fenceLanguage(node.textContent ?? "");
  }

  private onKeydown(ev: KeyboardEvent): void {
    const mod = ev.ctrlKey || ev.metaKey;
    // 块级转换那一步：`replaceWith` 不进原生撤销栈，转换后立刻 Ctrl+Z 由快照接管。
    if (mod && !ev.shiftKey && ev.key.toLowerCase() === "z" && this.undo) {
      ev.preventDefault();
      this.restoreUndo();
      return;
    }
    // ` ``` ` / ` ```ts ` 敲完回车才转换：立即转会把语言名截掉（打完三个反引号就把块换了，`ts` 再也补不上）。
    if (ev.key === "Enter" && !ev.shiftKey && !mod && !ev.altKey) {
      const lang = this.fenceAtCaret();
      if (lang !== null) {
        ev.preventDefault();
        this.makeCode(lang);
        return;
      }
      if (this.hrAtCaret()) {
        ev.preventDefault();
        this.makeHr();
        return;
      }
      const block = this.caretBlock();
      // 普通段落回车交给调用方（内网通发送）；列表 / 引用 / 代码块里仍续块。
      if (this.onEnter && block && !["LI", "UL", "OL", "BLOCKQUOTE", "PRE"].includes(block.tagName)) {
        ev.preventDefault();
        this.onEnter();
        return;
      }
    }
    // Alt+P：插一个原始 <p> 分段（粘进来的 div / 空段落清理用）。
    if (ev.altKey && !mod && ev.key.toLowerCase() === "p") {
      ev.preventDefault();
      this.exec("formatBlock", "p");
      return;
    }
    if (ev.key === "Tab" && mod) return;
  }

  private onPaste(ev: ClipboardEvent): void {
    const data = ev.clipboardData;
    if (!data) return;
    const files = [...data.files].filter((f) => f.type.startsWith("image/"));
    if (files.length && this.onFiles) {
      ev.preventDefault();
      this.onFiles(files);
      return;
    }
    ev.preventDefault();
    const html = data.getData("text/html");
    const text = data.getData("text/plain");
    // 「这段 html 值不值得净化」由 rich.ts 判定，别在这里另写一份标签清单（两份清单迟早会分叉）。
    const rich = html && hasAnyStructure(html) ? sanitizeRich(html) : "";
    // 净化后为空（html 里只有被丢弃的容器）时退回纯文本：别让这次粘贴静默消失。
    const insert = rich || escapeLines(text);
    if (!insert) return;
    document.execCommand("insertHTML", false, insert);
    this.saveRange();
    this.notify();
  }

  // ---------------------------------------------------------------- 动作

  /** 内联样式要的是「用户选中的那段」：活选区塌了就先回退到上次存下的非空选区。 */
  private inlineRange(): Range | null {
    const live = this.range();
    if (live && !live.collapsed) return live;
    const saved = this.savedRange;
    if (saved && !saved.collapsed && this.body.contains(saved.startContainer)) return saved;
    return live;
  }

  private wrapInline(prop: "color" | "background-color" | "font-size", value: string): void {
    const range = this.inlineRange();
    if (!range || range.collapsed) {
      this.say(tr("先选中要改的文字。"), true);
      return;
    }
    this.restore(range);
    const wrap = document.createElement("span");
    wrap.style.setProperty(prop, value);
    wrap.appendChild(range.extractContents());
    range.insertNode(wrap);
    const after = document.createRange();
    after.selectNodeContents(wrap);
    this.restore(after);
    this.notify();
  }

  /**
   * 把光标所在的块换成 `<pre><code>`；已经是代码块就换回段落。
   * 由 ``` 触发时，块里那几个反引号要清掉、语言名挂到 `code.language-*`（导出 Markdown 时用）。
   * 和块级输入规则一样走一次性快照，Ctrl+Z 能一步回到原段落。
   */
  private makeCode(value = ""): void {
    const block = this.caretBlock();
    if (!block) return;
    const original = block.cloneNode(true) as HTMLElement;
    let created: HTMLElement;
    let caretIn: HTMLElement;
    if (block.tagName === "PRE") {
      const p = document.createElement("p");
      const text = block.textContent ?? "";
      p.replaceChildren(parseHtml(text ? escapeLines(text) : "<br>"));
      created = p;
      caretIn = p;
    } else {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      const content = block.textContent ?? "";
      const fence = /^\s*```(\w*)\s*$/.exec(content);
      const lang = fence ? fence[1] : value;
      const text = fence ? "" : content;
      if (lang) code.className = `language-${lang}`;
      code.replaceChildren(parseHtml(text ? escapeLines(text) : "<br>"));
      pre.append(code);
      created = pre;
      caretIn = code;
    }
    const parent = block.parentNode;
    block.replaceWith(created);
    if (parent) this.undo = { parent, next: created.nextSibling, original, created: [created] };
    this.caretToEnd(caretIn);
    this.notify();
  }

  private hrAtCaret(): boolean {
    const block = this.caretBlock();
    return Boolean(block && block.tagName !== "PRE" && (block.textContent ?? "").trim() === "---");
  }

  /** 整行 `---` 回车：换成 `<hr>` + 后面一个空段落，光标落在空段落里。 */
  private makeHr(): void {
    const block = this.caretBlock();
    if (!block) return;
    const original = block.cloneNode(true) as HTMLElement;
    const hr = document.createElement("hr");
    const p = document.createElement("p");
    p.append(document.createElement("br"));
    const parent = block.parentNode;
    block.replaceWith(hr, p);
    if (parent) this.undo = { parent, next: p.nextSibling, original, created: [hr, p] };
    this.caretToEnd(p);
    this.notify();
  }

  private insertHtml(html: string): void {
    const range = this.range();
    if (range) this.restore(range);
    document.execCommand("insertHTML", false, html);
    this.saveRange();
    this.notify();
  }

  private toggleBlock(tag: string): void {
    const range = this.range();
    if (!range) return;
    let block: Node | null = range.startContainer;
    while (block && block.parentNode !== this.body) block = block.parentNode;
    // 点第二下取消：已经是这个块就换回段落。
    this.exec("formatBlock", block instanceof HTMLElement && block.tagName.toLowerCase() === tag ? "p" : tag);
  }

  // ---------------------------------------------------------------- 工具栏

  private buildToolbar(): void {
    const bar = this.toolbar;
    bar.classList.add("tb");
    bar.replaceChildren();
    const keep = (id: string): boolean => !this.tools || this.tools.has(id);
    const btn = (glyph: string, title: string, run: (el: HTMLElement) => void, cls = ""): HTMLElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `tb-btn${cls ? ` ${cls}` : ""}`;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.textContent = glyph;
      // mousedown 会抢走正文的焦点（选区就没了）：改成按下不抢焦点，点的时候自己恢复。
      b.addEventListener("mousedown", (ev) => ev.preventDefault());
      b.onclick = () => run(b);
      return b;
    };
    const sep = (): HTMLElement => {
      const s = document.createElement("span");
      s.className = "tb-sep";
      return s;
    };
    const parts: Array<HTMLElement | "sep"> = [];
    const add = (id: string, el: HTMLElement): void => {
      if (keep(id)) parts.push(el);
    };
    const gap = (): void => {
      if (parts.length && parts[parts.length - 1] !== "sep") parts.push("sep");
    };

    add("b", btn("B", tr("粗体（Ctrl+B）"), () => this.exec("bold"), "tb-b"));
    add("i", btn("I", tr("斜体"), () => this.exec("italic"), "tb-i"));
    add("u", btn("U", tr("下划线"), () => this.exec("underline"), "tb-u"));
    add("s", btn("S", tr("删除线"), () => this.exec("strikeThrough"), "tb-s"));
    gap();
    add("size", btn("A", tr("字号"), (el) => this.openSize(el)));
    add("color", btn("🎨", tr("文字颜色 / 底色"), (el) => this.openColor(el)));
    gap();
    add("ul", btn("•", tr("符号列表"), () => this.exec("insertUnorderedList"), "tb-wide"));
    add("ol", btn("1.", tr("编号列表"), () => this.exec("insertOrderedList"), "tb-wide"));
    gap();
    add("code", btn("</>", tr("代码块（整行输入 ``` 也行）"), () => this.makeCode()));
    add("table", btn("▦", tr("插入表格"), () => this.insertHtml(this.tableHtml()), "tb-wide"));
    add("hr", btn("—", tr("分隔线"), () => this.exec("insertHorizontalRule"), "tb-wide"));
    add("quote", btn("❝", tr("引用"), () => this.toggleBlock("blockquote"), "tb-wide"));

    const grow = document.createElement("div");
    grow.className = "grow";
    parts.push(grow);
    if (keep("more")) parts.push(btn("⋯", tr("更多"), (el) => this.openMore(el)));

    const out: HTMLElement[] = [];
    for (const p of parts) {
      if (p === "sep") {
        if (out.length && !out[out.length - 1].classList.contains("tb-sep")) out.push(sep());
      } else {
        out.push(p);
      }
    }
    while (out.length && out[out.length - 1].classList.contains("tb-sep")) out.pop();
    bar.append(...out);
  }

  private openPop(anchor: HTMLElement, node: HTMLElement): void {
    this.closePop();
    this.saveRange();
    node.className = "tb-pop";
    const box = anchor.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - 260))}px`;
    node.style.top = `${box.bottom + 6}px`;
    document.body.append(node);
    this.pop = node;
  }

  closePop(): void {
    this.pop?.remove();
    this.pop = null;
  }

  private openSize(anchor: HTMLElement): void {
    const pop = document.createElement("div");
    for (const [value, label] of SIZES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tb-size";
      b.textContent = tr(label);
      b.style.fontSize = value;
      b.onclick = () => {
        this.closePop();
        this.wrapInline("font-size", value);
      };
      pop.append(b);
    }
    this.openPop(anchor, pop);
  }

  private openColor(anchor: HTMLElement): void {
    const pop = document.createElement("div");
    let prop: "color" | "background-color" = "color";
    const tabs = document.createElement("div");
    tabs.className = "tb-tabs";
    const grid = document.createElement("div");
    grid.className = "tb-colors";
    const tab = (id: "color" | "background-color", label: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `tb-tab${prop === id ? " on" : ""}`;
      b.textContent = label;
      b.onclick = () => {
        prop = id;
        for (const other of tabs.children) other.classList.toggle("on", other === b);
      };
      return b;
    };
    tabs.append(tab("color", tr("文字色")), tab("background-color", tr("底色")));
    for (const color of COLORS) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "tb-swatch";
      sw.style.background = color;
      sw.title = color;
      sw.onclick = () => {
        this.closePop();
        this.wrapInline(prop, color);
      };
      grid.append(sw);
    }
    pop.append(tabs, grid);
    this.openPop(anchor, pop);
  }

  /** 插一张两列空表：表头文字跟着界面语言走，所以在这里拼而不是模块常量。 */
  private tableHtml(): string {
    const head = ["<th>", tr("列 1"), "</th><th>", tr("列 2"), "</th>"].join("");
    return `<table><tbody><tr>${head}</tr><tr><td>a</td><td>b</td></tr></tbody></table><p><br></p>`;
  }

  private openMore(anchor: HTMLElement): void {
    const pop = document.createElement("div");
    pop.className = "tb-pop tb-more";
    const item = (label: string, run: () => void): HTMLElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tb-more-item";
      b.textContent = label;
      b.onclick = () => {
        this.closePop();
        run();
      };
      return b;
    };
    pop.append(
      item(tr("字号"), () => this.openSize(anchor)),
      item(tr("文字颜色 / 底色"), () => this.openColor(anchor)),
      item(tr("符号列表"), () => this.exec("insertUnorderedList")),
      item(tr("编号列表"), () => this.exec("insertOrderedList")),
      item(tr("代码块"), () => this.makeCode()),
      item(tr("插入表格"), () => this.insertHtml(this.tableHtml())),
      item(tr("分隔线"), () => this.exec("insertHorizontalRule")),
      item(tr("引用"), () => this.toggleBlock("blockquote")),
      item(tr("清除格式"), () => this.exec("removeFormat")),
    );
    this.openPop(anchor, pop);
  }
}


/** 纯文本 → 段落；每行一个 `<p>`（编辑器里直接粘日志用）。 */
function escapeLines(text: string): string {
  return textToRich(text);
}

/** 光标在块内的字符偏移（只看文字节点；光标在元素层时按子节点累计）。 */
function textOffset(block: Element, node: Node, offset: number): number | null {
  if (!block.contains(node)) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    let total = 0;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode as Text;
      if (t === node) return total + offset;
      total += t.data.length;
    }
    return null;
  }
  if (node === block) {
    let total = 0;
    for (let i = 0; i < offset && i < block.childNodes.length; i++) total += block.childNodes[i].textContent?.length ?? 0;
    return total;
  }
  return null;
}

/** 把块内 [from, to) 的字符位置变成 DOM Range（跨多个文本节点也行）。 */
function rangeAtOffsets(block: Element, range: Range, from: number, to: number): boolean {
  let total = 0;
  let start: { node: Text; offset: number } | null = null;
  let end: { node: Text; offset: number } | null = null;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    const next = total + t.data.length;
    if (!start && from >= total && from <= next) start = { node: t, offset: from - total };
    if (!end && to >= total && to <= next) end = { node: t, offset: to - total };
    total = next;
    if (start && end) break;
  }
  if (!start || !end) return false;
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return true;
}

/** 本文件不写 innerHTML（仓库规矩：见 web/src/md.ts 抬头）：解析完再挂节点。 */
function parseHtml(html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const frag = document.createDocumentFragment();
  frag.append(...[...doc.body.childNodes].map((node) => document.importNode(node, true)));
  return frag;
}
