/**
 * Q-031: syntax highlighting for the file preview and for markdown code fences.
 *
 * highlight.js is pulled in piecemeal — `core` plus the languages named below — so Vite bundles only
 * this subset instead of the 386-grammar default build. Two rules keep it honest:
 *
 * - unknown languages stay plain text on purpose (`highlightAuto` tries every grammar, which is the
 *   wrong trade for a viewer that may be showing a 190 KB log);
 * - anything past `HL_MAX_BYTES` stays plain too, same reason (Q-031 决策 4).
 *
 * The returned string is HTML with the original text escaped by highlight.js, so `textContent` still
 * equals the source — copy/paste and the line gutter keep working.
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import css from "highlight.js/lib/languages/css";
import csharp from "highlight.js/lib/languages/csharp";
import dart from "highlight.js/lib/languages/dart";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import gradle from "highlight.js/lib/languages/gradle";
import groovy from "highlight.js/lib/languages/groovy";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import nix from "highlight.js/lib/languages/nix";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGS: Record<string, any> = {
  bash,
  c,
  css,
  csharp,
  dart,
  diff,
  dockerfile,
  go,
  gradle,
  groovy,
  ini,
  java,
  javascript,
  json,
  makefile,
  markdown,
  nix,
  powershell,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

for (const [name, grammar] of Object.entries(LANGS)) hljs.registerLanguage(name, grammar);

/**
 * Extension → grammar. Anything not listed here is shown as plain text: the grammars we ship are the
 * ones a coding agent actually previews (Q-031 决策 2), and the set already costs ~90 KB minified.
 * D227: dart / nix / groovy / gradle joined when pi 1.5.1 added them to its read and write views.
 * Still dropped on purpose: swift / php / kotlin / lua / ruby — add a line here (plus an import) when
 * a real file needs one.
 */
const BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  html: "xml",
  htm: "xml",
  xhtml: "xml",
  svg: "xml",
  vue: "xml",
  svelte: "xml",
  xml: "xml",
  css: "css",
  scss: "css",
  less: "css",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  pyi: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  psd1: "powershell",
  psm1: "powershell",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "c",
  cc: "c",
  cxx: "c",
  hpp: "c",
  cs: "csharp",
  dart: "dart",
  nix: "nix",
  groovy: "groovy",
  gradle: "gradle",
  diff: "diff",
  patch: "diff",
  mk: "makefile",
};

/** Filenames with no useful extension. */
const BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  "cmakelists.txt": "makefile",
};

/** Past this the text stays plain: one big file should not freeze the tab. */
export const HL_MAX_BYTES = 200 * 1024;

/** Grammar for a file or fence label, or null when we do not want to touch it. */
export function langOf(nameOrLabel: string): string | null {
  const raw = (nameOrLabel || "").trim().toLowerCase();
  if (!raw) return null;
  const named = BY_NAME[raw];
  if (named) return named;
  // Fence labels are often the language itself ("```ts"); previews hand us a file name ("app.ts"),
  // so both the whole label and its extension get a look.
  const bare = raw.split(/[\s,{}]/)[0];
  const dot = bare.lastIndexOf(".");
  const byExt = BY_EXT[bare] ?? (dot > 0 ? BY_EXT[bare.slice(dot + 1)] : undefined);
  if (byExt) return byExt;
  return Object.prototype.hasOwnProperty.call(LANGS, bare) ? bare : null;
}

/**
 * Highlighted HTML for `text`, or null when it should stay plain (unknown language, too big, or a
 * grammar that throws on this input — never let a viewer crash because of a code sample).
 */
export function highlightCode(text: string, nameOrLabel: string): string | null {
  const lang = langOf(nameOrLabel);
  if (!lang) return null;
  if (!text || text.length > HL_MAX_BYTES) return null;
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

/** hljs escapes exactly these five in its output; nothing else can appear inside its text nodes. */
const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
function unescapeHtml(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (m) => ENT[m] ?? m);
}

/**
 * Q-031: the same thing as DOM nodes, built from a whitelist instead of trusting hljs' string.
 *
 * Only `<span class="hljs-…">`, `</span>` and text are accepted; anything else in the markup is
 * dropped as-is. That keeps `web/src/md.ts`'s "no innerHTML anywhere" rule true — agent output is
 * untrusted text, and a highlighter is not a reason to start parsing it as markup.
 */
export function highlightFragment(text: string, nameOrLabel: string): DocumentFragment | null {
  const html = highlightCode(text, nameOrLabel);
  if (html === null) return null;
  const frag = document.createDocumentFragment();
  const stack: (DocumentFragment | HTMLElement)[] = [frag];
  const re = /<span class="((?:hljs-[\w-]+ ?)+)">|<\/span>|([^<]+)|<[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      const span = document.createElement("span");
      span.className = m[1].trim();
      top.append(span);
      stack.push(span);
    } else if (m[2] !== undefined) {
      top.append(document.createTextNode(unescapeHtml(m[2])));
    } else if (m[0] === "</span>") {
      if (stack.length > 1) stack.pop();
    }
  }
  return frag;
}
