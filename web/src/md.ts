/**
 * Tiny markdown renderer that builds DOM nodes directly.
 *
 * No innerHTML anywhere: agent output is untrusted text, and building nodes with
 * textContent keeps it inert no matter what it contains.
 *
 * Two modes: chat (default, one paragraph per line, headings toned down) and `doc` (a previewed
 * .md file: soft-wrapped paragraphs, real heading levels, relative links/images resolved by the
 * caller). File paths in either mode become links that open the preview drawer.
 */

import { highlightFragment } from "./highlight.ts";
import { tr } from "./i18n/index.ts";

export interface MdOptions {
  /** Rendering a whole document rather than a chat message. */
  doc?: boolean;
  /** Open a file path (relative paths are the caller's business). Default: the `pi-preview` event. */
  openPath?: (path: string) => void;
  /** Map a relative image src to a loadable url; return null to drop the image. */
  imageSrc?: (src: string) => string | null;
  /** GFM 表格；聊天气泡里关掉（表格在窄栏里没法读）。默认开。 */
  tables?: boolean;
}

/** Extensions worth linking when the text names a file that has a directory part. */
const CODE_EXT =
  "md|markdown|html?|png|jpe?g|gif|svg|webp|bmp|ico|txt|csv|tsv|log|json|jsonl|ya?ml|toml|ini|xml|pdf|tsx?|jsx?|mjs|cjs|vue|svelte|css|scss|less|py|rb|go|rs|java|kt|cs|cpp|cc|c|h|hpp|sh|ps1|bat|cmd|sql|lua|php|swift|dart|r|gradle|properties|env|lock|conf|cfg|mp4|m4v|webm|ogv|mov|mkv|avi|wmv|flv|mp3|wav|m4a|aac|ogg|oga|flac|opus";
// Name characters: no whitespace, quotes, brackets or CJK punctuation.
const NAME = "[^\\s`'\"<>|*?:()\\[\\]{}，。；：！？、（）【】「」『』《》\\\\/]";
const WIN_ABS = `[A-Za-z]:[\\\\/](?:${NAME}+[\\\\/])*${NAME}+\\.[A-Za-z0-9]{1,10}`;
const POSIX_ABS = `(?<![\\w.])/(?:${NAME}+/)+${NAME}+\\.(?:${CODE_EXT})`;
const REL_DIR = `(?<![\\w./\\\\])(?:\\.{1,2}[\\\\/])?(?:${NAME}+[\\\\/])+${NAME}+\\.(?:${CODE_EXT})`;
// A bare name (`问题记录.md`) is deliberately NOT a path: it does not say where the file is, and
// guessing a directory for it opens the wrong file sooner or later. Use a path, or the file manager.
const PATH_RE = new RegExp(`(${WIN_ABS})|(${POSIX_ABS})|(${REL_DIR})`, "g");
const PATH_WHOLE = new RegExp(`^(?:${WIN_ABS}|${POSIX_ABS}|${REL_DIR})$`);

function stripTrail(p: string): string {
  return p.replace(/[.,;:!?)\]}'"]+$/, "");
}

/** Does a code span (`src/app.ts`) name a file? A bare name (`README.md`) does not count. */
export function looksLikePath(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 400 || /\s/.test(t) || /^[a-z]+:\/\//i.test(t)) return false;
  return PATH_WHOLE.test(t);
}

function defaultOpen(path: string): void {
  window.dispatchEvent(new CustomEvent("pi-preview", { detail: { path } }));
}

/** An `<img>` for a markdown image, or null when the source may not be loaded (see `imageSrc`).
 * #542: `![…](x.mp4)` / `![…](a.mp3)` become a player instead (see `mediaNode`). */
function imageNode(alt: string, rawSrc: string, opts: MdOptions): HTMLElement | null {
  const kind = mediaKind(rawSrc);
  if (kind) return mediaNode(kind, rawSrc, alt, {}, opts);
  const src = /^https?:\/\//i.test(rawSrc) ? rawSrc : opts.imageSrc?.(rawSrc) ?? null;
  if (!src) return null;
  const img = document.createElement("img");
  img.src = src;
  img.alt = alt;
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  return img;
}

const VIDEO_EXT = "mp4|m4v|webm|ogv|mov|mkv|avi|wmv|flv";
const AUDIO_EXT = "mp3|wav|m4a|aac|ogg|oga|flac|opus";
const VIDEO_RE = new RegExp(`\\.(?:${VIDEO_EXT})$`, "i");
const AUDIO_RE = new RegExp(`\\.(?:${AUDIO_EXT})$`, "i");

/** Is this src a video / audio file (by extension, ignoring `?query` / `#hash`)? */
export function mediaKind(src: string): "video" | "audio" | null {
  const bare = src.split(/[?#]/)[0];
  return VIDEO_RE.test(bare) ? "video" : AUDIO_RE.test(bare) ? "audio" : null;
}

/** The only attributes a markdown `<video>` / `<audio>` keeps (#542). `controls` is always on and
 * `autoplay`, `on*`, `style` & co. are dropped by construction: nothing else is ever copied. */
export interface MediaAttrs {
  poster?: string;
  loop?: boolean;
  muted?: boolean;
  width?: number;
  height?: number;
}

function mediaFallbackNode(kind: "video" | "audio", rawSrc: string, label: string, opts: MdOptions): HTMLElement {
  const name = label || rawSrc.split(/[?#]/)[0].split(/[\\/]/).pop() || rawSrc;
  const text = kind === "video" ? tr("[视频：{p1}]", { p1: name }) : tr("[音频：{p1}]", { p1: name });
  if (/^https?:\/\//i.test(rawSrc)) {
    const a = document.createElement("a");
    a.href = rawSrc;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = text;
    return a;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawSrc) && !/^[A-Za-z]:[\\/]/.test(rawSrc)) {
    const span = document.createElement("span");
    span.textContent = text;
    return span;
  }
  return fileLink(rawSrc.split("#")[0], text, opts);
}

/**
 * A player for a media file referenced from markdown (#542). http(s) loads directly (same rule as
 * images); a relative src goes through `imageSrc`, exactly like an image. Where the caller has no
 * `imageSrc` (chat bubbles) or refuses the path, a local file becomes a link that opens the preview
 * instead — chat never embeds local media. A player that errors becomes that same link.
 */
function mediaNode(kind: "video" | "audio", rawSrc: string, label: string, attrs: MediaAttrs, opts: MdOptions): HTMLElement {
  const resolve = (s: string) => (/^https?:\/\//i.test(s) ? s : opts.imageSrc?.(s) ?? null);
  const src = resolve(rawSrc);
  if (!src) return mediaFallbackNode(kind, rawSrc, label, opts);
  const media = document.createElement(kind);
  media.className = "md-media";
  media.controls = true;
  media.preload = "metadata";
  if (label) media.title = label;
  if (attrs.loop) media.loop = true;
  if (attrs.muted) {
    media.muted = true;
    media.defaultMuted = true;
  }
  if (kind === "video") {
    const v = media as HTMLVideoElement;
    const poster = attrs.poster ? resolve(attrs.poster) : null;
    if (poster) v.poster = poster;
    if (attrs.width) v.width = attrs.width;
    if (attrs.height) v.height = attrs.height;
  }
  media.onerror = () => {
    if (media.isConnected) media.replaceWith(mediaFallbackNode(kind, rawSrc, label, opts));
  };
  media.src = src;
  return media;
}

/** Attributes of one start tag (`<video a="1" b='2' c=3 d>`), names lower-cased. */
function tagAttrs(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = tag.replace(/^<\s*[a-z]+/i, "").replace(/\/?>$/, "");
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

const MEDIA_TAG_START = /^\s*<(video|audio)(?=[\s>\/])/i;

/**
 * A block-level `<video …>` / `<audio …>` starting at `lines[i]` (#542): runs to its closing tag (may
 * span lines), or ends at the start tag itself when it is self-closing or nothing closes it before a
 * blank line. Returns the player and the index of the first line after the block.
 */
function mediaBlock(lines: string[], i: number, opts: MdOptions): { node: HTMLElement; next: number } | null {
  const start = MEDIA_TAG_START.exec(lines[i]);
  if (!start) return null;
  const kind = start[1].toLowerCase() as "video" | "audio";
  const close = new RegExp(`</\\s*${kind}\\s*>`, "i");
  let end = i;
  let text = lines[i];
  // The start tag itself may wrap; collect until its `>`.
  while (!/^[^>]*>/.test(text.replace(/"[^"]*"|'[^']*'/g, "")) && end + 1 < lines.length && lines[end + 1].trim()) {
    end += 1;
    text += `\n${lines[end]}`;
  }
  const tagEnd = (() => {
    const stripped = text.replace(/"[^"]*"|'[^']*'/g, (q) => "_".repeat(q.length));
    return stripped.indexOf(">");
  })();
  if (tagEnd < 0) return null;
  const openTag = text.slice(text.indexOf("<"), tagEnd + 1);
  const selfClosing = /\/\s*>$/.test(openTag);
  if (!selfClosing && !close.test(text)) {
    let k = end + 1;
    while (k < lines.length && lines[k].trim() && !close.test(lines[k])) k += 1;
    if (k < lines.length && close.test(lines[k])) {
      text += `\n${lines.slice(end + 1, k + 1).join("\n")}`;
      end = k;
    }
  }
  const attrs = tagAttrs(openTag);
  let src = attrs.get("src") ?? "";
  if (!src) {
    const source = /<source\b[^>]*>/i.exec(text.slice(tagEnd + 1));
    if (source) src = tagAttrs(source[0]).get("src") ?? "";
  }
  if (!src) return null;
  const num = (v: string | undefined) => (v && /^\d{1,5}$/.test(v.trim()) ? Number(v.trim()) : undefined);
  const picked: MediaAttrs = {
    poster: kind === "video" ? attrs.get("poster") || undefined : undefined,
    loop: attrs.has("loop"),
    muted: attrs.has("muted"),
    width: num(attrs.get("width")),
    height: num(attrs.get("height")),
  };
  const box = document.createElement("div");
  box.className = "md-media-block";
  box.appendChild(mediaNode(kind, src.trim(), "", picked, opts));
  return { node: box, next: end + 1 };
}

/** The anchor a markdown link asks for: external tab, in-page anchor, or file preview. */
function wrapHref(node: Node, href: string, opts: MdOptions): Node {
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.appendChild(node);
    return a;
  }
  if (href.startsWith("#")) {
    const span = document.createElement("span");
    span.className = "md-anchor";
    span.appendChild(node);
    return span;
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href) || /^[A-Za-z]:[\\/]/.test(href)) {
    const path = href.split("#")[0];
    const a = document.createElement("a");
    a.className = "file-link";
    a.href = "#";
    a.title = tr("预览 {p1}", { p1: path });
    a.appendChild(node);
    a.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      (opts.openPath ?? defaultOpen)(path);
    };
    return a;
  }
  return document.createTextNode(node.textContent ?? "");
}

function fileLink(path: string, label: string, opts: MdOptions, code = false, inlineLabel = false): HTMLElement {
  const a = document.createElement("a");
  a.className = code ? "file-link code" : "file-link";
  a.href = "#";
  a.title = tr("预览 {p1}", { p1: path });
  if (code) {
    const c = document.createElement("code");
    c.textContent = label;
    a.appendChild(c);
  } else if (inlineLabel) {
    // `[`docs/`](docs/)`: the label is markdown too, so a code span stays a code span instead of
    // showing its backticks. Nested links are suppressed — an <a> inside an <a> is not a thing.
    inlineInto(a, label, { ...opts, openPath: () => {} });
  } else a.textContent = label;
  a.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    (opts.openPath ?? defaultOpen)(path);
  };
  return a;
}

/** Plain text, with file paths turned into preview links. */
function textWithPaths(target: Node, text: string, opts: MdOptions): void {
  PATH_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(text))) {
    const raw = stripTrail(m[0]);
    if (!raw) continue;
    if (m.index > last) target.appendChild(document.createTextNode(text.slice(last, m.index)));
    target.appendChild(fileLink(raw, raw, opts));
    last = m.index + raw.length;
    PATH_RE.lastIndex = last;
  }
  if (last < text.length) target.appendChild(document.createTextNode(text.slice(last)));
}

// Link labels may nest brackets (`[![badge](a)](b)`), so the label is `(?:plain char | [balanced])+`.
// D95: the `plain char` branch must NOT be `[^\[\]\n]+` — `(x+|\[…\])+` is ambiguous (any run of
// label text can be split into pieces in exponentially many ways), and on a `[…]` that never closes
// with `](` the engine burns 2^n steps. That is not theory: a tool result containing a code line like
// `|| [...this.termTabs.get(id)]` was enough to freeze the chat page forever on session c24330ab
// (D95); user messages are plain text and never reach this regex.
const INLINE =
  /(`[^`\n]+`)|(!\[[^\]\n]*\]\([^\s)]+(?:\s+"[^"]*")?\))|((?<!!)\[(?:[^\[\]\n]|\[[^\]\n]*\])+\]\([^\s)]+(?:\s+"[^"]*")?\))|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(~~[^~\n]+~~)|((?<![\w*])\*[^*\s][^*\n]*\*(?!\w)|(?<![\w_])_[^_\s][^_\n]*_(?![\w_]))|(https?:\/\/[^\s<>()（）]+[^\s<>()（）.,;:!?。，；：！？])/g;

function inlineInto(target: Node, text: string, opts: MdOptions): void {
  const re = new RegExp(INLINE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) textWithPaths(target, text.slice(last, m.index), opts);
    const token = m[0];
    if (m[1]) {
      const inner = token.slice(1, -1);
      if (looksLikePath(inner)) target.appendChild(fileLink(inner.trim(), inner, opts, true));
      else {
        const code = document.createElement("code");
        code.textContent = inner;
        target.appendChild(code);
      }
    } else if (m[2]) {
      const im = /^!\[([^\]]*)\]\(([^\s)]+)/.exec(token)!;
      const img = imageNode(im[1], im[2], opts);
      if (img) target.appendChild(img);
      else target.appendChild(document.createTextNode(im[1] ? tr("[图片：{p1}]", { p1: im[1] }) : tr("[图片]")));
    } else if (m[3]) {
      const lm = /^\[((?:[^\[\]\n]|\[[^\]\n]*\])+)\]\(([^\s)]+)/.exec(token)!;
      const label = lm[1];
      const href = lm[2];
      // `[![badge](https://…)](https://…)`: the label is an image. Before the label could contain
      // brackets this fell through to the *inner* link and rendered `<a>![License…</a>](LICENSE)`.
      const pic = /^!\[([^\]]*)\]\(([^\s)]+)\)$/.exec(label);
      if (pic) {
        const img = imageNode(pic[1], pic[2], opts);
        // A player inside an <a> would navigate on every click of its controls (#542).
        if (img && mediaKind(pic[2])) target.appendChild(img);
        else if (img) target.appendChild(wrapHref(img, href, opts));
        else target.appendChild(document.createTextNode(pic[1] || tr("[图片]")));
      } else if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noreferrer";
        inlineInto(a, label, { ...opts, openPath: () => {} });
        target.appendChild(a);
      } else if (href.startsWith("#")) {
        const span = document.createElement("span");
        span.className = "md-anchor";
        inlineInto(span, label, opts);
        target.appendChild(span);
      } else if (!/^[a-z][a-z0-9+.-]*:/i.test(href) || /^[A-Za-z]:[\\/]/.test(href)) {
        target.appendChild(fileLink(href.split("#")[0], label, opts, false, true));
      } else target.appendChild(document.createTextNode(label));
    } else if (m[4]) {
      const strong = document.createElement("strong");
      inlineInto(strong, token.slice(2, -2), opts);
      target.appendChild(strong);
    } else if (m[5]) {
      const del = document.createElement("del");
      inlineInto(del, token.slice(2, -2), opts);
      target.appendChild(del);
    } else if (m[6]) {
      const em = document.createElement("em");
      inlineInto(em, token.slice(1, -1), opts);
      target.appendChild(em);
    } else {
      const a = document.createElement("a");
      a.href = token;
      a.target = "_blank";
      a.rel = "noreferrer";
      a.textContent = token;
      target.appendChild(a);
    }
    last = m.index + token.length;
  }
  if (last < text.length) textWithPaths(target, text.slice(last), opts);
}

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function renderMarkdown(src: string, opts: MdOptions = {}): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const doc = Boolean(opts.doc);
  let list: HTMLElement | null = null;
  let i = 0;

  // Front matter in a document is metadata, not prose.
  if (doc && lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === "---");
    if (end > 0) {
      const pre = document.createElement("pre");
      pre.className = "md-front";
      pre.textContent = lines.slice(1, end).join("\n");
      frag.appendChild(pre);
      i = end + 1;
    }
  }

  const closeList = () => {
    list = null;
  };
  const isBlockStart = (l: string) =>
    /^\s*(```|~~~)/.test(l) || /^#{1,6}\s/.test(l) || /^\s*([-*+]|\d+[.)])\s+/.test(l) || /^\s*>/.test(l) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(l) || /^\s*\|/.test(l) || MEDIA_TAG_START.test(l);

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^\s*(```|~~~)\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      closeList();
      const body: string[] = [];
      i += 1;
      const close = new RegExp(`^\\s*${fence[1]}\\s*$`);
      while (i < lines.length && !close.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      const pre = document.createElement("pre");
      if (fence[2]) pre.dataset.lang = fence[2];
      const code = document.createElement("code");
      const text = body.join("\n");
      // Q-031: 围栏带语言且我们认识 → 上色；否则照旧纯文本。片段由高亮器的白名单构造，不经过
      // innerHTML（本文件的规矩：agent 输出永远是文本，不当标记解）。
      const hlFrag = fence[2] ? highlightFragment(text, fence[2]) : null;
      if (hlFrag === null) {
        code.textContent = text;
      } else {
        code.className = "hl";
        code.append(hlFrag);
        pre.classList.add("hl");
      }
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    if (/^\s*$/.test(line)) {
      closeList();
      i += 1;
      continue;
    }

    if (MEDIA_TAG_START.test(line)) {
      const block = mediaBlock(lines, i, opts);
      if (block) {
        closeList();
        frag.appendChild(block.node);
        i = block.next;
        continue;
      }
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeList();
      frag.appendChild(document.createElement("hr"));
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      closeList();
      const level = doc ? heading[1].length : Math.min(6, heading[1].length + 2);
      const h = document.createElement(`h${level}`);
      inlineInto(h, heading[2], opts);
      frag.appendChild(h);
      i += 1;
      continue;
    }

    if ((opts.tables ?? true) && /^\s*\|?.*\|/.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      closeList();
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
      const wrap = document.createElement("div");
      wrap.className = "md-table";
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const tr = document.createElement("tr");
      head.forEach((c, k) => {
        const th = document.createElement("th");
        if (aligns[k]) th.style.textAlign = aligns[k];
        inlineInto(th, c, opts);
        tr.appendChild(th);
      });
      thead.appendChild(tr);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      i += 2;
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        const row = document.createElement("tr");
        const cells = splitRow(lines[i]);
        for (let k = 0; k < head.length; k++) {
          const td = document.createElement("td");
          if (aligns[k]) td.style.textAlign = aligns[k];
          inlineInto(td, cells[k] ?? "", opts);
          row.appendChild(td);
        }
        tbody.appendChild(row);
        i += 1;
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      frag.appendChild(wrap);
      continue;
    }

    if (/^\s*>/.test(line)) {
      closeList();
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      const bq = document.createElement("blockquote");
      bq.appendChild(renderMarkdown(body.join("\n"), opts));
      frag.appendChild(bq);
      continue;
    }

    const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const tag = ul ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = document.createElement(tag);
        if (ol && ol[2] !== "1") list.setAttribute("start", ol[2]);
        frag.appendChild(list);
      }
      const li = document.createElement("li");
      const indent = (ul ?? ol)![1].length;
      if (indent >= 2) li.style.marginLeft = `${Math.min(6, Math.floor(indent / 2)) * 16}px`;
      let content = ul ? ul[2] : ol![3];
      const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
      if (task) {
        li.className = "task";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.disabled = true;
        box.checked = task[1] !== " ";
        li.appendChild(box);
        content = task[2];
      }
      inlineInto(li, content, opts);
      list.appendChild(li);
      i += 1;
      continue;
    }

    closeList();
    const p = document.createElement("p");
    if (doc) {
      // Soft-wrapped lines belong to one paragraph; a trailing double space is a hard break.
      const parts: string[] = [line];
      i += 1;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
        parts.push(lines[i]);
        i += 1;
      }
      parts.forEach((part, k) => {
        if (k > 0) {
          if (/ {2,}$|\\$/.test(parts[k - 1])) p.appendChild(document.createElement("br"));
          else p.appendChild(document.createTextNode(" "));
        }
        inlineInto(p, part.replace(/ {2,}$|\\$/, "").trim(), opts);
      });
    } else {
      inlineInto(p, line, opts);
      i += 1;
    }
    frag.appendChild(p);
  }

  return frag;
}
