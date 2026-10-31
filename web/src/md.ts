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

export interface MdOptions {
  /** Rendering a whole document rather than a chat message. */
  doc?: boolean;
  /** Open a file path (relative paths are the caller's business). Default: the `pi-preview` event. */
  openPath?: (path: string) => void;
  /** Map a relative image src to a loadable url; return null to drop the image. */
  imageSrc?: (src: string) => string | null;
}

/** Extensions worth linking when the text names a file that has a directory part. */
const CODE_EXT =
  "md|markdown|html?|png|jpe?g|gif|svg|webp|bmp|ico|txt|csv|tsv|log|json|jsonl|ya?ml|toml|ini|xml|pdf|tsx?|jsx?|mjs|cjs|vue|svelte|css|scss|less|py|rb|go|rs|java|kt|cs|cpp|cc|c|h|hpp|sh|ps1|bat|cmd|sql|lua|php|swift|dart|r|gradle|properties|env|lock|conf|cfg";
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

function fileLink(path: string, label: string, opts: MdOptions, code = false): HTMLElement {
  const a = document.createElement("a");
  a.className = code ? "file-link code" : "file-link";
  a.href = "#";
  a.title = `预览 ${path}`;
  if (code) {
    const c = document.createElement("code");
    c.textContent = label;
    a.appendChild(c);
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

const INLINE =
  /(`[^`\n]+`)|(!\[[^\]\n]*\]\([^\s)]+(?:\s+"[^"]*")?\))|(\[[^\]\n]+\]\([^\s)]+(?:\s+"[^"]*")?\))|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(~~[^~\n]+~~)|((?<![\w*])\*[^*\s][^*\n]*\*(?!\w)|(?<![\w_])_[^_\s][^_\n]*_(?![\w_]))|(https?:\/\/[^\s<>()（）]+[^\s<>()（）.,;:!?。，；：！？])/g;

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
      const src = /^https?:\/\//i.test(im[2]) ? im[2] : opts.imageSrc?.(im[2]) ?? null;
      if (src) {
        const img = document.createElement("img");
        img.src = src;
        img.alt = im[1];
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        target.appendChild(img);
      } else target.appendChild(document.createTextNode(im[1] ? `[图片：${im[1]}]` : "[图片]"));
    } else if (m[3]) {
      const lm = /^\[([^\]]+)\]\(([^\s)]+)/.exec(token)!;
      const href = lm[2];
      if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noreferrer";
        inlineInto(a, lm[1], { ...opts, openPath: () => {} });
        target.appendChild(a);
      } else if (href.startsWith("#")) {
        const span = document.createElement("span");
        span.className = "md-anchor";
        inlineInto(span, lm[1], opts);
        target.appendChild(span);
      } else if (!/^[a-z][a-z0-9+.-]*:/i.test(href) || /^[A-Za-z]:[\\/]/.test(href)) {
        target.appendChild(fileLink(href.split("#")[0], lm[1], opts));
      } else target.appendChild(document.createTextNode(lm[1]));
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
    /^\s*(```|~~~)/.test(l) || /^#{1,6}\s/.test(l) || /^\s*([-*+]|\d+[.)])\s+/.test(l) || /^\s*>/.test(l) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(l) || /^\s*\|/.test(l);

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
      code.textContent = body.join("\n");
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    if (/^\s*$/.test(line)) {
      closeList();
      i += 1;
      continue;
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

    if (/^\s*\|?.*\|/.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
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
