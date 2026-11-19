/**
 * #486 记录面板的富文本正文。
 *
 * `Note.body` 从纯文本换成了**净化过的 HTML**（在 contenteditable 里编辑）。这个模块只做纯函数：
 * 净化白名单、导出纯文本 / Markdown、把老数据（纯文本）回填成段落、识别整行的 ``` 触发。
 *
 * 为什么不用 DOMParser 走一遍：净化必须在没有 `document` 的地方也能测（node --test），而且
 * `<template>` / `innerHTML` 那条路在坏标签上太宽容 —— 手写一个「只认白名单」的解析器更好审。
 *
 * 白名单与取舍见 #486：无害的结构 + 粗斜下删代码表格；颜色 / 底色 / em 字号用 `span[style]`；
 * 链接只留 http(s)（不主动做富文本链接，但粘贴进来的要能活）。
 */

const ALLOWED = new Set([
  "p",
  "br",
  "h1",
  "h2",
  "h3",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "strike",
  "del",
  "ul",
  "ol",
  "li",
  "code",
  "pre",
  "blockquote",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "span",
  "mark",
  "a",
]);

const VOID = new Set(["br", "hr"]);

/** 会单独占一行的标签：透明容器里只要有它们，就不能把容器升成段落。 */
const BLOCK_LEVEL = new Set(["p", "br", "h1", "h2", "h3", "ul", "ol", "li", "pre", "blockquote", "hr", "table", "thead", "tbody", "tr", "th", "td"]);
/** 白名单外但按行分块的标签（浏览器 Ctrl+C 网页常产出 `<div>一行</div>`）。 */
const BLOCKISH = new Set(["div", "section", "article", "header", "footer", "aside", "nav", "main", "figure", "figcaption", "dl", "dt", "dd", "address", "center", "form", "fieldset", "legend", "details", "summary", "h4", "h5", "h6"]);

/** 这些标签连里面的字一起扔：粘一份带 <script> 的页面进来时不该留下死代码。 */
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "svg", "math", "template", "noscript", "textarea", "title", "head", "img"]);

const STYLE_PROPS = new Set(["color", "background-color", "font-size"]);

const BLOCK_TAG = /<(p|br|h[1-6]|ul|ol|li|pre|blockquote|hr|table|thead|tbody|tr|th|td)\b[^>]*>/i;
/** 老 body 里只要有这些行内标签，也说明它已经是 HTML 了（否则 `<b>x</b>` 会被再转义一遍）。 */
const INLINE_TAG = /<(strong|b|em|i|u|s|strike|del|span|mark|a)\b[^>]*>/i;

interface RichNode {
  tag: string | null;
  attrs: Record<string, string>;
  children: RichNode[];
  text?: string;
  /** 丢弃区 / 透明容器的原始标签名：闭合标签靠它对上。 */
  name?: string;
}

// ---------------------------------------------------------------- 解析 / 净化

const TOKEN = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
const ENTITY = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);?/gi;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

function decode(s: string): string {
  return s.replace(ENTITY, (all, body: string) => {
    const low = body.toLowerCase();
    if (low.startsWith("#x")) return String.fromCodePoint(parseInt(low.slice(2), 16) || 32);
    if (low.startsWith("#")) return String.fromCodePoint(parseInt(low.slice(1), 10) || 32);
    return NAMED[low] ?? all;
  });
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 只留颜色 / 底色 / em 字号；能带 url()、expression() 的值一律丢。 */
function cleanStyle(raw: string): string {
  const out: string[] = [];
  for (const decl of raw.split(";")) {
    const at = decl.indexOf(":");
    if (at < 0) continue;
    const prop = decl.slice(0, at).trim().toLowerCase();
    const value = decl.slice(at + 1).trim().toLowerCase();
    if (!prop || !value || !STYLE_PROPS.has(prop)) continue;
    if (prop === "font-size") {
      const m = /^(\d+(?:\.\d+)?)em$/.exec(value);
      const n = m ? Number(m[1]) : NaN;
      if (!m || !(n >= 0.5 && n <= 4)) continue;
    } else if (!/^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\([0-9.,%\s]+\)|[a-z]{3,20})$/.test(value)) {
      continue;
    }
    out.push(`${prop}: ${value}`);
  }
  return out.join("; ");
}

function sanitizeAttrs(tag: string, raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (tag === "span") {
    const m = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i.exec(raw);
    const style = m ? cleanStyle(decode(m[2] ?? m[3] ?? "")) : "";
    if (style) attrs.style = style;
  } else if (tag === "a") {
    const m = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(raw);
    const href = decode(m ? (m[2] ?? m[3] ?? "") : "").trim();
    // 绝对 http(s) 与站内 `/` 路径（#511：输入规则认这两种）；其余协议（javascript: 等）一律丢掉。
    if (/^(https?:\/\/[^\s]+|\/[^\s]*)$/i.test(href)) attrs.href = href;
  } else if (tag === "code") {
    // 代码块的语言挂在 `class="language-xx"`（编辑器 makeCode 写，导出 Markdown 用）。
    const m = /\bclass\s*=\s*("([^"]*)"|'([^']*)')/i.exec(raw);
    const cls = m ? decode(m[2] ?? m[3] ?? "") : "";
    const lang = /(?:^|\s)language-([a-z0-9+#.-]{1,20})/i.exec(cls);
    if (lang) attrs.class = `language-${lang[1]}`;
  }
  return attrs;
}

/** 白名单净化：不认识的标签拆掉留字，危险标签连字一起扔，标签补闭合。幂等。 */
export function sanitizeRich(html: string): string {
  const root: RichNode = { tag: null, attrs: {}, children: [] };
  const stack: RichNode[] = [root];
  const top = (): RichNode => stack[stack.length - 1];

  const append = (node: RichNode): void => {
    if (stack.some((n) => n.tag === "#drop")) return;
    top().children.push(node);
  };

  let last = 0;
  TOKEN.lastIndex = 0;

  // 白名单外的块级容器（典型是浏览器复制出来的 `<div>一行</div>`）：悬空时把内容包成段落，
  // 否则多行粘贴会全挤成一行。容器里已经有块级元素（例如 div 套 p）时保持透明，免得多套一层。
  const blockify = (node: RichNode): void => {
    if (node.tag !== "#keep" || !node.name || !BLOCKISH.has(node.name)) return;
    if (!node.children.length || hasBlockLevel(node)) return;
    node.tag = "p";
    node.name = undefined;
  };

  for (let m = TOKEN.exec(html); m; m = TOKEN.exec(html)) {
    const between = html.slice(last, m.index);
    if (between) append({ tag: null, attrs: {}, children: [], text: decode(between) });
    last = m.index + m[0].length;
    if (m[0].startsWith("<!--")) continue;

    const name = (m[1] ?? "").toLowerCase();
    const rawAttrs = m[2] ?? "";
    const selfClose = m[3] === "/";
    const closing = m[0].startsWith("</");

    if (closing) {
      // 找最近的同名开标签；找不到就是多余的闭合，忽略。#drop 靠 name 认（见下）。
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === name || stack[i].name === name) {
          const node = stack[i];
          stack.length = i;
          blockify(node);
          break;
        }
      }
      continue;
    }

    if (DROP_WITH_CONTENT.has(name)) {
      // 压栈时记下原始标签名：`</head>` / `</script>` 得能对上。漏了名字的话 #drop 永远弹不出去，
      // append 会把**后面全部内容**一起扔掉（浏览器 Ctrl+C 出来的 html 自带 <html><head>…）。
      // img / embed 没有闭合标签，不压栈，否则之后的正文全丢。
      if (!selfClose && name !== "img" && name !== "embed") stack.push({ tag: "#drop", name, attrs: {}, children: [] });
      continue;
    }

    if (!ALLOWED.has(name)) {
      // 不认识的标签：丢掉标签本身，内容照常走（<div> 这类只是分区）。
      // 节点必须先挂到树上再压栈：只压不挂的话，后面 append 都塞进这个孤儿节点，最后整段消失。
      if (!selfClose) {
        const keep: RichNode = { tag: "#keep", name, attrs: {}, children: [] };
        append(keep);
        stack.push(keep);
      }
      continue;
    }

    const node: RichNode = { tag: name, attrs: sanitizeAttrs(name, rawAttrs), children: [] };
    append(node);
    const transparent = (name === "span" && !node.attrs.style) || (name === "a" && !node.attrs.href);
    if (transparent) {
      node.tag = "#keep"; // 没有有效属性的 span / a：当成透明容器
      node.name = name; // 闭合标签还得能对上，否则后面的内容会被塞进这个容器里面
    }
    if (!selfClose && !VOID.has(name)) stack.push(node);
  }
  const tail = html.slice(last);
  if (tail) append({ tag: null, attrs: {}, children: [], text: decode(tail) });
  // 没闭合的块级容器（粘一半的 html）也包一下，从里往外。
  for (let i = stack.length - 1; i > 0; i--) blockify(stack[i]);

  return serialize(root.children);
}

/** 子树里有没有能单独占行的元素（含已转成 p 的容器）。 */
function hasBlockLevel(node: RichNode): boolean {
  return node.children.some((c) => (c.tag !== null && BLOCK_LEVEL.has(c.tag)) || hasBlockLevel(c));
}

const TRANSPARENT = /^#/;

function serialize(nodes: RichNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.tag === "#drop") continue;
    if (!node.tag) {
      out += escapeHtml(node.text ?? "");
      continue;
    }
    if (TRANSPARENT.test(node.tag)) {
      out += serialize(node.children);
      continue;
    }
    const attrs = Object.entries(node.attrs)
      .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
      .join("");
    out += `<${node.tag}${attrs}>`;
    if (!VOID.has(node.tag)) out += `${serialize(node.children)}</${node.tag}>`;
  }
  return out;
}

/**
 * 老数据（纯文本）→ 富文本；已经是富文本的原样净化。两条路都幂等。
 *
 * 分段按 #486 写的那条：**空行切段落、单换行当 `<br>`**，先转义再包 `<p>`。
 */
export function textToRich(text: string): string {
  if (hasRichMarkup(text)) {
    const clean = sanitizeRich(text);
    // 只有行内标签的老 body（`<b>x</b>`）净化完还是散的，包成段落才和编辑器一个形状。
    return BLOCK_TAG.test(clean) ? clean : paragraphize(clean, (s) => s);
  }
  return paragraphize(text, escapeHtml);
}

/** 空行切段落、单换行当 `<br>`；`keep` 决定里面那段文本要不要转义。 */
function paragraphize(text: string, keep: (s: string) => string): string {
  return text
    .split(/\r?\n[ \t]*\r?\n/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== "")
    .map((chunk) => `<p>${chunk.split(/\r?\n/).map(keep).join("<br>")}</p>`)
    .join("");
}

/**
 * 「已经是富文本」：出现正文里认得的标签才算（块标签或行内标签）。
 * 日志里的 `<13:45:02>`、`a < b` 不能误判，所以只认白名单里的标签名。
 */
export function hasRichMarkup(s: string): boolean {
  return BLOCK_TAG.test(s) || INLINE_TAG.test(s);
}

// ---------------------------------------------------------------- 读

/** 纯文本（搜索、摘要、导出共用）：块之间一行，表格格子用空格分。 */
export function plainText(html: string): string {
  const block = (s: string): string => `\n${s}\n`;
  const walk = (nodes: RichNode[]): string =>
    nodes
      .map((node) => {
        if (!node.tag) return node.text ?? "";
        if (node.tag === "br") return "\n";
        if (node.tag === "td" || node.tag === "th") return `${node.children.map((c) => walk([c])).join("")} `;
        const inner = walk(node.children);
        switch (node.tag) {
          case "p":
          case "h1":
          case "h2":
          case "h3":
          case "li":
          case "blockquote":
            return block(inner);
          case "pre":
            return block(inner.replace(/\n$/, ""));
          case "tr":
            return block(inner.trimEnd());
          case "hr":
            return "\n";
          default:
            return inner;
        }
      })
      .join("");

  return walk(parse(html))
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** 原样取文字：`<pre>` 里的空行、缩进都得留着（Markdown 代码块要用）。 */
function rawText(nodes: RichNode[]): string {
  return nodes
    .map((node) => {
      if (!node.tag) return node.text ?? "";
      if (node.tag === "br") return "\n";
      return rawText(node.children);
    })
    .join("")
    .replace(/\u00a0/g, " ");
}

export function isRichEmpty(html: string): boolean {
  if (!html) return true;
  return plainText(html).trim() === "" && !/<(hr|table)\b/i.test(html);
}

/** 整行 ` ``` ` 或 ` ```ts ` → 代码块；返回语言（空串 = 无语言），不触发返回 null。 */
export function fenceLanguage(text: string): string | null {
  const m = /^```([a-z0-9+#.-]{0,20})$/i.exec(text.trim());
  if (!m) return null;
  return m[1];
}

// ---------------------------------------------------------------- 导出 Markdown

/** 正文 → Markdown。纯视觉的东西（颜色、底色、字号、mark）丢，结构尽量留着。 */
export function richToMarkdown(html: string): string {
  const inline = (nodes: RichNode[]): string =>
    nodes
      .map((node) => {
        if (!node.tag) return node.text ?? "";
        const inner = inline(node.children);
        switch (node.tag) {
          case "strong":
          case "b":
            return inner.trim() ? `**${inner}**` : inner;
          case "em":
          case "i":
            return inner.trim() ? `*${inner}*` : inner;
          case "u":
            return `<u>${inner}</u>`;
          case "s":
          case "strike":
          case "del":
            return inner.trim() ? `~~${inner}~~` : inner;
          case "code":
            return `\`${inner}\``;
          case "a":
            return node.attrs.href ? `[${inner}](${node.attrs.href})` : inner;
          case "br":
            return "\n";
          default:
            return inner;
        }
      })
      .join("");

  const blocks = (nodes: RichNode[], listStyle: "" | "-" | "1." = ""): string => {
    let out = "";
    for (const node of nodes) {
      if (!node.tag) {
        out += node.text ?? "";
        continue;
      }
      switch (node.tag) {
        case "h1":
        case "h2":
        case "h3":
          out += `${"#".repeat(Number(node.tag[1]))} ${inline(node.children).trim()}\n\n`;
          break;
        case "p":
          out += `${inline(node.children)}\n\n`;
          break;
        case "br":
          out += "\n";
          break;
        case "hr":
          out += "---\n\n";
          break;
        case "pre": {
          // 语言名挂在 `<code class="language-xx">` 上（净化白名单只留这一种 class）。
          const codeNode = node.children.find((c) => c.tag === "code");
          const lang = /(?:^|\s)language-([a-z0-9+#.-]{1,20})/i.exec(codeNode?.attrs.class ?? "")?.[1] ?? "";
          const code = rawText(node.children).replace(/\s+$/, "");
          out += `\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
          break;
        }
        case "blockquote": {
          const inner = blocks(node.children).trim();
          out += `${inner.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n")}\n\n`;
          break;
        }
        case "ul":
        case "ol":
          out += `${listOf(node, node.tag === "ul" ? "-" : "1.")}\n`;
          break;
        case "table":
          out += tableOf(node);
          break;
        default:
          out += blocks(node.children, listStyle);
      }
    }
    return out;
  };

  const listOf = (node: RichNode, bullet: string): string =>
    node.children
      .filter((c) => c.tag === "li")
      .map((li) => `${bullet} ${inline(li.children).trim()}`)
      .join("\n");

  const tableOf = (node: RichNode): string => {
    const rows: string[] = [];
    const visit = (n: RichNode): void => {
      if (n.tag === "tr") {
        const cells = n.children.filter((c) => c.tag === "td" || c.tag === "th").map((c) => inline(c.children).trim());
        rows.push(`| ${cells.join(" | ")} |`);
        if (rows.length === 1) rows.push(`| ${cells.map(() => "---").join(" | ")} |`);
        return;
      }
      n.children.forEach(visit);
    };
    visit(node);
    return rows.length ? `${rows.join("\n")}\n\n` : "";
  };

  return blocks(parse(sanitizeRich(html)))
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 「发送给好友」的文本（#509 / #511）：标题 + 空行 + 正文 Markdown；正文为空只发标题。
 * 标题与正文的长度拦截在调用方（记录面板）做，这里只负责拼。
 */
export function noteTextForPeer(title: string, html: string): string {
  const head = title.trim();
  const body = richToMarkdown(html).trim();
  if (!body) return head;
  return head ? `${head}\n\n${body}` : body;
}

/** 净化后的 HTML 再解析成一棵树（导出纯文本 / Markdown 用）。 */function parse(html: string): RichNode[] {
  const clean = sanitizeRich(html);
  const root: RichNode = { tag: null, attrs: {}, children: [] };
  const stack: RichNode[] = [root];
  const TOK2 = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let last = 0;
  for (let m = TOK2.exec(clean); m; m = TOK2.exec(clean)) {
    const between = clean.slice(last, m.index);
    if (between) stack[stack.length - 1].children.push({ tag: null, attrs: {}, children: [], text: decode(between) });
    last = m.index + m[0].length;
    const name = m[2].toLowerCase();
    if (m[1]) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const node: RichNode = { tag: name, attrs: sanitizeAttrs(name, m[3] ?? ""), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!m[4] && !VOID.has(name)) stack.push(node);
  }
  const tail = clean.slice(last);
  if (tail) stack[stack.length - 1].children.push({ tag: null, attrs: {}, children: [], text: decode(tail) });
  return root.children;
}
