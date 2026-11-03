/**
 * Syntax highlighting for code the page shows: previewed files, markdown fences, and the command
 * line on a tool card.
 *
 * Hand-rolled on purpose (D64): no shiki / highlight.js / prism. The page only ever renders a
 * handful of languages, the whole thing is a single pass over the string, and it keeps the
 * no-innerHTML invariant that md.ts documents — tokens become `span` nodes built with
 * `textContent`, so highlighted output is exactly as inert as plain text.
 *
 * It is a lexer, not a parser: comments, strings, numbers, keywords, and (a cheap heuristic)
 * types vs function calls. That is enough to make a 600-line .ts file readable, and it never
 * fails — an unknown language or a broken quote just degrades to plainer output.
 */

export type TokenKind = "comment" | "string" | "number" | "keyword" | "type" | "func" | "attr" | "punct" | "add" | "del" | "plain";

export interface Token {
  k: TokenKind;
  t: string;
}

interface Spec {
  /** Space-separated keywords. */
  kw?: string;
  /** Line-comment prefixes. */
  line?: string[];
  /** Block comment delimiters. */
  block?: [string, string][];
  /** Quote characters that start a string. */
  quotes?: string;
  /** Quotes that may run past a newline (`"` in JS, `"""` in Python). */
  multiline?: string[];
  /** Python-style triple quotes. */
  triple?: string[];
  /** Capitalised identifiers are types (TS/Go/Rust/Java/C#). */
  types?: boolean;
  /** `name(` reads as a function call rather than a variable. */
  funcs?: boolean;
  /** Angle-bracket markup: html / xml / vue / svelte. */
  markup?: boolean;
  /** Line-oriented unified diff. */
  diff?: boolean;
}

const JS_KW =
  "as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield";
const TS_TYPES =
  "any bigint boolean never number object string symbol unknown void Record Partial Readonly Pick Omit Promise Array Map Set Date RegExp Error";

const SPECS: Record<string, Spec> = {
  js: {
    kw: `${JS_KW} ${TS_TYPES}`,
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: `"'\``,
    multiline: ["`"],
    types: true,
    funcs: true,
  },
  json: { kw: "true false null", quotes: `"`, funcs: false },
  css: { block: [["/*", "*/"]], quotes: `"'` },
  markup: { markup: true },
  bash: { kw: "if then else elif fi for while do done case esac function return export local readonly cd echo exit set unset source alias shift trap in", line: ["#"], quotes: `"'\``, funcs: true },
  powershell: {
    kw: "if else elseif foreach for while do switch function param return try catch finally throw begin process end filter in not and or true false null",
    line: ["#"],
    block: [["<#", "#>"]],
    quotes: `"'\``,
    funcs: true,
  },
  python: {
    kw: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self match case",
    line: ["#"],
    quotes: `"'`,
    multiline: ['"""', "'''"],
    triple: ['"""', "'''"],
    types: true,
    funcs: true,
  },
  go: {
    kw: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota string int int64 float64 bool byte rune error make new len cap append panic recover",
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: `"'\``,
    multiline: ["`"],
    types: true,
    funcs: true,
  },
  rust: {
    kw: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err",
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: `"'`,
    types: true,
    funcs: true,
  },
  java: {
    kw: "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed",
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: `"'`,
    types: true,
    funcs: true,
  },
  sql: {
    kw: "select from where and or not null insert into values update set delete create table index view drop alter add column primary key foreign references join left right inner outer on group by order having limit offset union all distinct as case when then else end begin commit rollback exists is like in between asc desc default",
    line: ["--"],
    block: [["/*", "*/"]],
    quotes: `'"`,
    funcs: true,
  },
  yaml: { kw: "true false null yes no on off", line: ["#"], quotes: `"'"` },
  ini: { kw: "true false", line: ["#", ";"], quotes: `"'"` },
  diff: { diff: true },
};

/** Extension / fence-alias → language. Anything missing stays plain text, which is the safe side. */
const BY_EXT: Record<string, string> = {
  ts: "js", tsx: "js", js: "js", jsx: "js", mjs: "js", cjs: "js", mts: "js", cts: "js", vue: "markup", svelte: "markup",
  json: "json", jsonl: "json", json5: "json", webmanifest: "json",
  css: "css", scss: "css", less: "css",
  html: "markup", htm: "markup", xhtml: "markup", xml: "markup", svg: "markup",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash", ps1: "powershell", ps: "powershell", psm1: "powershell",
  py: "python", pyi: "python",
  go: "go", rs: "rust", java: "java", kt: "java", kts: "java", cs: "java", scala: "java", swift: "java", dart: "java",
  c: "java", h: "java", cc: "java", cpp: "java", cxx: "java", hpp: "java",
  sql: "sql", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini", properties: "ini", env: "ini",
  diff: "diff", patch: "diff",
};

/** Markdown fence aliases (`ts` / `typescript`, `sh` / `bash`, …). */
const BY_ALIAS: Record<string, string> = {
  ...BY_EXT,
  javascript: "js", typescript: "js", jsonc: "json", shell: "bash", console: "bash", shellsession: "bash",
  py: "python", python3: "python", golang: "go", rust: "rust", md: "", markdown: "", text: "", txt: "", plain: "",
};

const norm = (s: string) => s.trim().toLowerCase().replace(/^\./, "");

/** Language for a file name (`approval-gate.ts` → js), or null when it is not worth colouring. */
export function langOfFile(name: string): string | null {
  const ext = norm(name.split(".").pop() ?? "");
  return BY_EXT[ext] ?? null;
}

/** Language for a markdown fence alias, or null. */
export function langOfAlias(alias: string | undefined): string | null {
  if (!alias) return null;
  const key = norm(alias);
  const hit = BY_ALIAS[key];
  return hit === undefined ? null : hit || null;
}

const ID_START = /[\p{L}_$]/u;
const ID_PART = /[\p{L}\p{N}_$]/u;
const DIGIT = /[0-9]/;
const NUM_RE = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)n?/;

function isKw(spec: Spec, word: string): boolean {
  return Boolean(spec.kw && new RegExp(`(?:^| )${word.replace(/[$]/g, "\\$")}(?: |$)`).test(spec.kw));
}

/** Highlighted tokens for `code`. Unknown language → one plain token (the caller can skip us). */
export function tokenize(code: string, lang: string | null): Token[] {
  const spec = lang ? SPECS[lang] : undefined;
  if (!spec) return [{ k: "plain", t: code }];
  if (spec.diff) return diffTokens(code);
  if (spec.markup) return markupTokens(code);

  const out: Token[] = [];
  const push = (k: TokenKind, t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    // Merge neighbours of the same kind: fewer spans, and plain runs stay one text node.
    if (last && last.k === k) last.t += t;
    else out.push({ k, t });
  };

  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i);

    // comments first: `// x` must not become a string
    const line = spec.line?.find((p) => rest.startsWith(p));
    if (line) {
      const nl = rest.indexOf("\n");
      const end = nl === -1 ? code.length : i + nl;
      push("comment", code.slice(i, end));
      i = end;
      continue;
    }
    const block = spec.block?.find(([open]) => rest.startsWith(open));
    if (block) {
      const close = code.indexOf(block[1], i + block[0].length);
      const end = close === -1 ? code.length : close + block[1].length;
      push("comment", code.slice(i, end));
      i = end;
      continue;
    }

    // triple quotes before single ones, otherwise `"""` opens a string that ends at the 3rd quote
    const triple = spec.triple?.find((q) => rest.startsWith(q));
    if (triple) {
      const close = code.indexOf(triple, i + triple.length);
      const end = close === -1 ? code.length : close + triple.length;
      push("string", code.slice(i, end));
      i = end;
      continue;
    }

    const ch = rest[0];
    const q = spec.quotes?.includes(ch) ? ch : null;
    if (q) {
      const multiline = spec.multiline?.some((m) => m.startsWith(q) && rest.startsWith(m)) ?? false;
      let j = i + 1;
      while (j < code.length) {
        const c = code[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === q) {
          j += 1;
          break;
        }
        if (c === "\n" && !multiline) break; // unterminated: stop at the line end, never swallow the file
        j += 1;
      }
      push("string", code.slice(i, j));
      i = j;
      continue;
    }

    if (DIGIT.test(ch)) {
      const m = NUM_RE.exec(rest);
      if (m) {
        push("number", m[0]);
        i += m[0].length;
        continue;
      }
    }

    if (ID_START.test(ch)) {
      let j = i + 1;
      while (j < code.length && ID_PART.test(code[j])) j += 1;
      const word = code.slice(i, j);
      if (isKw(spec, word)) push("keyword", word);
      else if (spec.types && /^[A-Z]/.test(word)) push("type", word);
      else if (spec.funcs && /^\s*\(/.test(code.slice(j, j + 40))) push("func", word);
      else push("plain", word);
      i = j;
      continue;
    }

    if (/[{}[\]();,.:=+\-*/%<>!&|?^~@#\\]/.test(ch)) push("punct", ch);
    else push("plain", ch);
    i += 1;
  }
  return out;
}

/** `<div class="x">` — tag names as keywords, attribute names as attrs, quoted values as strings. */
function markupTokens(code: string): Token[] {
  const out: Token[] = [];
  const push = (k: TokenKind, t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.k === k) last.t += t;
    else out.push({ k, t });
  };
  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i);
    if (rest.startsWith("<!--")) {
      const close = code.indexOf("-->", i + 4);
      const end = close === -1 ? code.length : close + 3;
      push("comment", code.slice(i, end));
      i = end;
      continue;
    }
    if (rest[0] !== "<") {
      // Text run: stop at the next tag so it stays one plain token.
      const next = code.indexOf("<", i);
      const end = next === -1 ? code.length : next;
      push("plain", code.slice(i, end));
      i = end;
      continue;
    }
    push("punct", "<");
    i += 1;
    if (code[i] === "/") {
      push("punct", "/");
      i += 1;
    }
    const name = /^[A-Za-z][\w:-]*/.exec(code.slice(i));
    if (name) {
      push("keyword", name[0]);
      i += name[0].length;
    }
    while (i < code.length && code[i] !== ">") {
      const space = /^\s+/.exec(code.slice(i));
      if (space) {
        push("plain", space[0]);
        i += space[0].length;
        continue;
      }
      const attr = /^[A-Za-z_:][\w:.-]*/.exec(code.slice(i));
      if (attr) {
        push("attr", attr[0]);
        i += attr[0].length;
        continue;
      }
      const eq = /^=\s*/.exec(code.slice(i));
      if (eq) {
        push("punct", eq[0].trimEnd());
        i += eq[0].length;
        continue;
      }
      const val = /^"[^"]*"|^'[^']*'/.exec(code.slice(i));
      if (val) {
        push("string", val[0]);
        i += val[0].length;
        continue;
      }
      push("plain", code[i]);
      i += 1;
    }
    if (code[i] === ">") {
      push("punct", ">");
      i += 1;
    }
  }
  return out;
}

/** Unified diff: `+++`/`---` headers, `@@` hunks, `+`/`-` lines. */
function diffTokens(code: string): Token[] {
  const out: Token[] = [];
  const lines = code.split("\n");
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n];
    const k: TokenKind =
      /^(?:\+\+\+|---|diff |index |new file|deleted file|similarity|rename )/.test(line)
        ? "comment"
        : /^@@/.test(line)
          ? "keyword"
          : /^\+/.test(line)
            ? "add"
            : /^-/.test(line)
              ? "del"
              : "plain";
    out.push({ k, t: line + (n === lines.length - 1 ? "" : "\n") });
  }
  return out;
}

/** Cap on how much text we colour: past this the spans cost more than they are worth. */
export const MAX_HIGHLIGHT_CHARS = 60_000;

/**
 * Append `code` to `host` as token spans. Falls back to one plain text node when the language is
 * unknown or the text is too long, so callers never have to special-case it.
 */
export function highlightInto(host: HTMLElement, code: string, lang: string | null): void {
  if (!lang || code.length > MAX_HIGHLIGHT_CHARS) {
    host.textContent = code;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const tok of tokenize(code, lang)) {
    if (tok.k === "plain") {
      frag.append(document.createTextNode(tok.t));
      continue;
    }
    const span = document.createElement("span");
    span.className = `tok-${tok.k}`;
    span.textContent = tok.t;
    frag.append(span);
  }
  host.append(frag);
}
