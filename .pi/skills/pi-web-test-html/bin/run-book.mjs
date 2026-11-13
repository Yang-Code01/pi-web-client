#!/usr/bin/env node
/**
 * 测试书驱动：把「一个模块的验收用例」跑成一份带截图的结果集。
 *
 *   node .pi/skills/pi-web-test-html/bin/run-book.mjs --case workclock
 *
 * 它负责所有与用例无关的脏活：起浏览器、登录测试实例、按步截图、把每步的
 * 预期/实际/判定收进 spec.json、打印摘要。用例本身写在 cases/<name>.mjs，
 * 只调用 h.openCase / h.step / h.ok / h.fail / h.shot。
 *
 * 参数：
 *   --case <name>   用例集（cases/<name>.mjs），默认 workclock
 *   --base <url>    测试实例地址，默认 http://127.0.0.1:17876
 *   --pass <口令>   登录口令，默认 test
 *   --out <dir>     产物目录，默认 <主检出>/.scratch/testbook/<case>
 *   --root <dir>    仓库根（默认按 cwd 推断）
 *
 * 产物目录默认落在**主检出**的 .scratch 下，即使当前在某个 worktree 里跑：
 * 产物是未跟踪文件，worktree 一删就跟着没了（本项目真出过这种事）。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const SKILL = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const repoRoot = path.resolve(arg("root", process.cwd()));
const BASE = arg("base", process.env.WK_BASE ?? "http://127.0.0.1:17876");
const PASS = arg("pass", process.env.WK_PASS ?? "test");
const caseName = arg("case", "workclock");

function mainRoot(root) {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
    return path.dirname(common);
  } catch {
    return root;
  }
}

const OUT = path.resolve(arg("out", path.join(mainRoot(repoRoot), ".scratch/testbook", caseName)));
const SHOTS = path.join(OUT, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

const localStamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const ps = (command) => {
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", command], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

const { loadPlaywright } = await import(pathToFileURL(path.join(mainRoot(repoRoot), "tools/playwright.mjs")).href);
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "zh-CN", viewport: { width: 1440, height: 940 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

const login = await ctx.request.post(`${BASE}/api/login`, { data: { passphrase: PASS } });
if (login.status() !== 200) throw new Error(`登录失败 HTTP ${login.status()}（口令 ${PASS}，先确认 ${BASE} 是测试实例）`);

const cases = [];
let cur = null;
let stepNo = 0;

function openCase(meta) {
  cur = { ...meta, startedAt: localStamp(), steps: [], verdict: "通过", note: "" };
  cases.push(cur);
  stepNo = 0;
  return cur;
}

function step(action, expected) {
  stepNo += 1;
  const s = { no: stepNo, action, expected, actual: "", verdict: "通过", shot: null, shots: [], evidence: [] };
  cur.steps.push(s);
  return s;
}

function fail(s, why) {
  s.verdict = "失败";
  s.actual = s.actual ? `${s.actual}；${why}` : why;
  if (cur.verdict === "通过") cur.verdict = "失败";
}

function ok(s, actual) {
  s.actual = actual;
}

/** 截元素而不是视口：测试书里贴的是「这一步看到的那块界面」。元素会在重渲染中换掉，所以重试。 */
async function shot(s, selector, name) {
  const file = path.join(SHOTS, `${cur.id}-${s.no}-${name}.png`);
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const target = page.locator(selector).first();
      await target.waitFor({ timeout: 15_000 });
      await target.scrollIntoViewIfNeeded().catch(() => {});
      const box = await target.boundingBox();
      await target.screenshot({ path: file, animations: "disabled" });
      const one = {
        file: path.relative(OUT, file).split(path.sep).join("/"),
        w: Math.round(box?.width ?? 0),
        h: Math.round(box?.height ?? 0),
      };
      s.shots.push(one);
      if (!s.shot) s.shot = one;
      return one;
    } catch (err) {
      lastErr = err;
      await page.waitForTimeout(600);
    }
  }
  throw lastErr;
}

const api = async (p) => (await ctx.request.get(`${BASE}${p}`)).json();
const apiPost = async (p, data) => ctx.request.post(`${BASE}${p}`, { data });

const h = {
  page,
  ctx,
  browser,
  base: BASE,
  api,
  apiPost,
  ps,
  openCase,
  step,
  ok,
  fail,
  shot,
  cases,
  get cur() {
    return cur;
  },
  sortCases: (order) => cases.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)),
  log: (msg) => console.log(`  · ${msg}`),
};

const mod = await import(pathToFileURL(path.join(SKILL, "cases", `${caseName}.mjs`)).href);
const meta = mod.meta ?? {};
console.log(`用例集 ${caseName} → ${BASE}`);
const startedAt = Date.now();
await mod.default(h);

const countOf = (verdict) => cases.filter((c) => c.verdict === verdict).length;
const summary = {
  cases: cases.length,
  pass: countOf("通过"),
  fail: countOf("失败"),
  manual: countOf("人工"),
  steps: cases.reduce((n, c) => n + c.steps.length, 0),
  shots: cases.reduce((n, c) => n + c.steps.reduce((m, x) => m + x.shots.length, 0), 0),
};

const spec = {
  title: meta.title ?? `${caseName} 测试书`,
  module: meta.module ?? caseName,
  branch: meta.branch ?? "",
  pr: meta.pr ?? "",
  decision: meta.decision ?? "",
  output: meta.output ?? meta.module ?? caseName,
  runAt: localStamp(),
  durationMs: Date.now() - startedAt,
  base: BASE,
  env: {
    os: ps("[System.Environment]::OSVersion.VersionString"),
    user: `${process.env.USERNAME ?? ""}（${ps("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)") ? "管理员" : "非管理员"}）`,
    hasAdmin: ps("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"),
    node: process.version,
    bridge: BASE,
    passphrase: PASS,
    pageLocale: "zh-CN",
    viewport: "1440×940",
    powershell: ps("$PSVersionTable.PSVersion.ToString()"),
    pwsh5: ps("[System.Environment]::OSVersion.Version.Build"),
    gitHead: (() => {
      try {
        return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    })(),
    ...(meta.extraEnv ?? {}),
  },
  pageErrors,
  summary,
  cases,
};

fs.writeFileSync(path.join(OUT, "spec.json"), JSON.stringify(spec, null, 1), "utf8");

const pass = summary.pass;
const failed = summary.fail;
const manual = summary.manual;
const steps = summary.steps;
const shotCount = summary.shots;

console.log(`\n用例 ${cases.length} 条：通过 ${pass}、失败 ${failed}、人工 ${manual}（${steps} 步，${shotCount} 张截图）`);
for (const c of cases) console.log(`  ${c.verdict.padEnd(2)}  ${c.id} ${c.title}`);
console.log(`\n产物 ${OUT}`);
await browser.close();
if (summary.fail > 0) process.exitCode = 1;
