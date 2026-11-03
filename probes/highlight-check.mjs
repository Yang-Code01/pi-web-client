/**
 * Probe: the syntax highlighter (D64) is a lexer that rebuilds the source from its own tokens, so the
 * one invariant worth testing is exactly that — `tokens.map(t => t.t).join("") === source`. A rule
 * that swallows a line (a `/*` declared as a *line* comment did exactly that) shows up here as a
 * mismatch instead of as a silently shortened file in the viewer.
 *
 * Also pins the extension / fence-alias mapping, and that an unknown language degrades to a single
 * plain token rather than throwing or guessing.
 *
 * Run: node --experimental-strip-types probes/highlight-check.mjs
 */
import { langOfAlias, langOfFile, tokenize } from "../web/src/highlight.ts";

const samples = {
  js: [
    "const s = `a ${b} c`;\nlet re = /ab+c/g; // trailing\n/* block\n   comment */\nexport type X = { a: string };",
    'const t = "he said \\"hi\\"" ; // 中文注释\nfoo(1_000, 0xFF, 1e-3);',
  ],
  python: ['def f(x):\n    """doc\n    string"""\n    return {"k": None}  # tail'],
  markup: ['<div class="x" data-y=\'1\'>text &amp; <br/></div>\n<!-- c -->'],
  css: ["a { color: #fff; /* c */ background: url('x.png'); }"],
  diff: ["diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same\n"],
  bash: ["rg -n 'a b' src && echo done # note"],
  json: ['{"a": [1, true, null], "b": "x"}'],
  sql: ["SELECT * FROM t -- c\nWHERE a = 'x';"],
  yaml: ["# c\nkey: value\nlist:\n  - a\n"],
};

let bad = 0;
for (const [lang, list] of Object.entries(samples)) {
  for (const code of list) {
    const toks = tokenize(code, lang);
    const rebuilt = toks.map((t) => t.t).join("");
    if (rebuilt !== code) {
      bad += 1;
      console.log(`FAIL ${lang}: tokens do not rebuild the source\n  in : ${JSON.stringify(code)}\n  out: ${JSON.stringify(rebuilt)}`);
      continue;
    }
    const kinds = {};
    for (const t of toks) kinds[t.k] = (kinds[t.k] ?? 0) + 1;
    console.log(`ok ${lang.padEnd(7)} ${String(toks.length).padStart(3)} tokens  ${JSON.stringify(kinds)}`);
  }
}

// `#fff` is a colour, not a comment — the css rule that treated `/*` as a line comment ate the rest
// of the line, which is how this specific case got caught.
const cssColour = tokenize("a { color: #fff; }", "css");
if (cssColour.some((t) => t.k === "comment")) {
  bad += 1;
  console.log("FAIL css: `#fff` must not be a comment");
}

const unknown = tokenize("nonsense", null);
if (unknown.length !== 1 || unknown[0].k !== "plain") {
  bad += 1;
  console.log("FAIL unknown language must stay one plain token");
}

const files = [
  ["approval-gate.ts", "js"],
  ["a.json", "json"],
  ["x.sh", "bash"],
  ["y.py", "python"],
  ["z.yml", "yaml"],
  ["w.html", "markup"],
  ["p.diff", "diff"],
  ["n.unknownext", null],
];
for (const [file, want] of files) {
  const got = langOfFile(file);
  if (got !== want) {
    bad += 1;
    console.log(`FAIL langOfFile(${file}) = ${got}, want ${want}`);
  }
}
if (langOfAlias("typescript") !== "js" || langOfAlias("md") !== null || langOfAlias("") !== null) {
  bad += 1;
  console.log("FAIL langOfAlias");
}

console.log(bad ? `\n${bad} FAILURE(S)` : "\nall invariants hold");
process.exitCode = bad ? 1 : 0;
