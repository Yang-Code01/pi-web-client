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
 *   --cwd <dir>     先建一个工作目录指向它的会话再开始（用例要开文件预览时用）
 *   --video         全程录屏：跑完转成 <out>/run.mp4，每步的时间点进 spec.video.marks
 *   --size WxH      录屏尺寸，默认 1440x940（必须 ≤ 视口）
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

/** 录像：默认关（头less 跑不吃这个开销），--video 才录，产物是 <out>/run.mp4。 */
const VIDEO = argv.includes("--video");
/** 节奇：`--pace 3` 把所有停顿乘 3。录屏给人看时用，默认 1（不拖慢回归）。 */
const PACE = Math.max(0.25, Number(arg("pace", "1")) || 1);
const VIDEO_DIR = path.join(OUT, "video");
if (VIDEO) fs.mkdirSync(VIDEO_DIR, { recursive: true });
const [VW, VH] = (arg("size", "1440x940").split("x").map(Number));
const SESSION_CWD = arg("cwd", "");
const marks = [];
let t0 = Date.now();

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
t0 = Date.now();
const ctx = await browser.newContext({
  locale: "zh-CN",
  viewport: { width: 1440, height: 940 },
  ...(VIDEO ? { recordVideo: { dir: VIDEO_DIR, size: { width: VW, height: VH } } } : {}),
});
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

const login = await ctx.request.post(`${BASE}/api/login`, { data: { passphrase: PASS } });
if (login.status() !== 200) throw new Error(`登录失败 HTTP ${login.status()}（口令 ${PASS}，先确认 ${BASE} 是测试实例）`);

/** 用例要开「文件」预览时，得有个 cwd 指向夹具目录的会话：走 WS create，和界面上新建会话等价。 */
let session = null;
async function openSession(cwd, name) {
  fs.mkdirSync(cwd, { recursive: true });
  const { WebSocket } = await import("ws");
  const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws`, { headers: { cookie } });
  const seen = [];
  ws.on("message", (b) => seen.push(JSON.parse(b.toString())));
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  ws.send(JSON.stringify({ type: "create", cwd, name }));
  let id = null;
  for (let i = 0; i < 300 && !id; i += 1) {
    id = seen.find((m) => m.type === "session" && m.state?.id)?.state?.id ?? null;
    if (!id) await new Promise((r) => setTimeout(r, 100));
  }
  ws.close();
  if (!id) throw new Error("建会话超时：WS 没回 session");
  session = { id, cwd };
  await page.goto(`${BASE}/#/s/${id}`, { waitUntil: "networkidle" });
  await page.locator(".topbar .icon-btn").first().waitFor({ timeout: 20_000 });
  return session;
}
if (SESSION_CWD) await openSession(path.resolve(SESSION_CWD), `testbook-${caseName}`);

let SET_META = {};
const cases = [];
let cur = null;
let stepNo = 0;

function openCase(meta) {
  // 用例集级别的模块名/优先级当默认值：用例只写自己变的那点。
  cur = {
    module: "",
    priority: "",
    ...meta,
    startedAt: localStamp(),
    steps: [],
    verdict: "通过",
    note: "",
  };
  cur.module ||= SET_META.module ?? "";
  cases.push(cur);
  stepNo = 0;
  return cur;
}

function step(action, expected) {
  stepNo += 1;
  const s = { no: stepNo, action, expected, actual: "", verdict: "通过", shot: null, shots: [], evidence: [] };
  cur.steps.push(s);
  if (VIDEO) marks.push({ case: cur.id, no: stepNo, label: action, t: (Date.now() - t0) / 1000 });
  return s;
}

function fail(s, why) {
  s.verdict = "失败";
  s.actual = s.actual ? `${s.actual}；${why}` : why;
  if (cur.verdict === "通过") cur.verdict = "失败";
}

function ok(s, actual) {
  // 一步里可能有好几条断言：一条覆盖一条会把前一条的证据（尤其失败原因）抹掉。
  s.actual = s.actual ? `${s.actual}；${actual}` : actual;
}

/** 给人看的停顿：真机回归不需要，录屏时用 `--pace 3` 把所有停顿拉长，画面才跟得上。 */
async function pause(ms = 700) {
  await page.waitForTimeout(Math.round(ms * PACE));
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
  session,
  openSession,
  video: { on: VIDEO },
  api,
  apiPost,
  ps,
  openCase,
  step,
  ok,
  fail,
  shot,
  pause,
  cases,
  get cur() {
    return cur;
  },
  sortCases: (order) => cases.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)),
  log: (msg) => console.log(`  · ${msg}`),
};

const mod = await import(pathToFileURL(path.join(SKILL, "cases", `${caseName}.mjs`)).href);
const meta = mod.meta ?? {};
SET_META = meta;
console.log(`用例集 ${caseName} → ${BASE}${VIDEO ? "（录屏中）" : ""}`);
const startedAt = Date.now();
await mod.default(h);

/** 录像要等页面/上下文关掉才落盘；转 mp4 是为了任何浏览器、任何预览器都放得动。 */
async function finishVideo() {
  if (!VIDEO) return null;
  const webm = await (async () => {
    await page.close();
    const p = await page.video().path();
    await ctx.close();
    return p;
  })();
  const mp4 = path.join(OUT, "run.mp4");
  const poster = path.join(SHOTS, "poster.png");
  try {
    execFileSync("ffmpeg", ["-y", "-i", webm, "-an", "-vf", `scale=${VW}:${VH}:flags=lanczos`, "-c:v", "libx264", "-preset", "medium", "-crf", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4], { stdio: "ignore" });
    execFileSync("ffmpeg", ["-y", "-ss", "1", "-i", mp4, "-frames:v", "1", poster], { stdio: "ignore" });
  } catch (err) {
    console.warn(`  转 mp4 失败（${err.message}），保留 webm：${webm}`);
    return { file: path.relative(OUT, webm).split(path.sep).join("/"), poster: null, w: VW, h: VH, seconds: 0, bytes: fs.statSync(webm).size, marks };
  }
  const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4], { encoding: "utf8" }).trim();
  return {
    file: "run.mp4",
    poster: fs.existsSync(poster) ? path.relative(OUT, poster).split(path.sep).join("/") : null,
    w: VW,
    h: VH,
    seconds: Math.round(Number(probe) * 10) / 10,
    bytes: fs.statSync(mp4).size,
    marks,
  };
}
const video = await finishVideo();

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
  // 用例集可以带自己的结论段/复跑步骤（xlsx 的「总览」「环境与准备」用它，缺省才用内置文案）。
  ...(meta.spec ?? {}),
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
    viewport: `${VW}×${VH}`,
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
  ...(video ? { video } : {}),
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
if (video) console.log(`录像 ${video.seconds}s / ${(video.bytes / 1048576).toFixed(1)} MB → ${path.join(OUT, video.file)}`);
console.log(`\n产物 ${OUT}`);
await browser.close();
if (summary.fail > 0) process.exitCode = 1;
