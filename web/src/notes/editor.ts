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
import { fenceLanguage, sanitizeRich, textToRich } from "./rich.ts";

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
}

export class RichEditor {
  private readonly body: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly onChange: () => void;
  private readonly say: (text: string, bad?: boolean) => void;
  private readonly onFiles: ((files: File[]) => void) | null;
  private savedRange: Range | null = null;
  private pop: HTMLElement | null = null;
  private readonly onOutside = (ev: MouseEvent): void => {
    const t = ev.target;
    if (!(t instanceof Node)) return;
    if (this.pop && !this.pop.contains(t) && !this.toolbar.contains(t)) this.closePop();
  };
  private readonly onDocKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape" && this.pop) {
      ev.preventDefault();
      this.closePop();
    }
  };

  constructor(opts: RichEditorOptions) {
    this.body = opts.body;
    this.toolbar = opts.toolbar;
    this.onChange = opts.onChange;
    this.onFiles = opts.onFiles ?? null;
    this.say = opts.say ?? (() => {});
    this.body.setAttribute("contenteditable", "true");
    this.body.spellcheck = false;
    this.body.classList.add("rich");
    this.body.addEventListener("input", () => this.afterInput());
    this.body.addEventListener("keydown", (ev) => this.onKeydown(ev));
    this.body.addEventListener("keyup", () => this.saveRange());
    this.body.addEventListener("mouseup", () => this.saveRange());
    this.body.addEventListener("blur", () => this.saveRange());
    this.body.addEventListener("paste", (ev) => this.onPaste(ev));
    this.buildToolbar();
    document.addEventListener("mousedown", this.onOutside, true);
    document.addEventListener("keydown", this.onDocKey, true);
  }

  /** 换一条记录：直接换 HTML（进门前已经净化过）。 */
  setHtml(html: string): void {
    this.body.replaceChildren(parseHtml(sanitizeRich(html)));
    this.savedRange = null;
    this.closePop();
  }

  /** 读回当前正文（净化过）。 */
  html(): string {
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
    this.onChange();
  }

  // ---------------------------------------------------------------- 输入

  private afterInput(): void {
    this.saveRange();
    this.onChange();
    const trigger = this.fenceAtCaret();
    if (trigger !== null) this.makeCode(trigger);
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
    if (mod && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === "b") {
      ev.preventDefault();
      this.exec("bold");
      return;
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
    const insert = html && /<(p|br|div|strong|em|ul|li|pre|h[1-6])\b/i.test(html) ? sanitizeRich(html) : escapeLines(text);
    if (!insert) return;
    document.execCommand("insertHTML", false, insert);
    this.saveRange();
    this.onChange();
  }

  // ---------------------------------------------------------------- 动作

  private wrapInline(prop: "color" | "background-color" | "font-size", value: string): void {
    const range = this.range();
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
    this.onChange();
  }

  /** 把光标所在的块换成 `<pre><code>`；已经是代码块就换回段落。 */
  private makeCode(value = ""): void {
    const range = this.range();
    if (!range) return;
    let block: Node | null = range.startContainer;
    while (block && block.parentNode !== this.body) block = block.parentNode;
    if (!(block instanceof Element)) return;
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    if (block instanceof HTMLElement && block.tagName === "PRE") {
      const p = document.createElement("p");
      const text = block.textContent ?? "";
      p.replaceChildren(parseHtml(text ? escapeLines(text) : "<br>"));
      block.replaceWith(p);
      const caret = document.createRange();
      caret.selectNodeContents(p);
      caret.collapse(false);
      this.restore(caret);
    } else {
      const content = block.textContent ?? "";
      code.replaceChildren(parseHtml(content || value ? escapeLines(content || value) : "<br>"));
      pre.append(code);
      block.replaceWith(pre);
      const caret = document.createRange();
      caret.selectNodeContents(code);
      caret.collapse(false);
      this.restore(caret);
    }
    this.onChange();
  }

  private insertHtml(html: string): void {
    const range = this.range();
    if (range) this.restore(range);
    document.execCommand("insertHTML", false, html);
    this.saveRange();
    this.onChange();
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

    bar.append(
      btn("B", tr("粗体（Ctrl+B）"), () => this.exec("bold"), "tb-b"),
      btn("I", tr("斜体"), () => this.exec("italic"), "tb-i"),
      btn("U", tr("下划线"), () => this.exec("underline"), "tb-u"),
      btn("S", tr("删除线"), () => this.exec("strikeThrough"), "tb-s"),
      sep(),
      btn("A", tr("字号"), (el) => this.openSize(el), "tb-wide"),
      btn("🎨", tr("文字颜色 / 底色"), (el) => this.openColor(el), "tb-wide"),
      sep(),
      btn("•", tr("符号列表"), () => this.exec("insertUnorderedList")),
      btn("1.", tr("编号列表"), () => this.exec("insertOrderedList")),
      sep(),
      btn("</>", tr("代码块（整行输入 ``` 也行）"), () => this.makeCode(), "tb-wide"),
      btn("▦", tr("插入表格"), () => this.insertHtml(this.tableHtml()), "tb-wide"),
      btn("—", tr("分隔线"), () => this.exec("insertHorizontalRule"), "tb-wide"),
      btn("❝", tr("引用"), () => this.toggleBlock("blockquote"), "tb-wide"),
      (() => {
        const grow = document.createElement("div");
        grow.className = "grow";
        return grow;
      })(),
      btn("⋯", tr("更多"), (el) => this.openMore(el)),
    );
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

/** 本文件不写 innerHTML（仓库规矩：见 web/src/md.ts 抬头）：解析完再挂节点。 */
function parseHtml(html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const frag = document.createDocumentFragment();
  frag.append(...[...doc.body.childNodes].map((node) => document.importNode(node, true)));
  return frag;
}
