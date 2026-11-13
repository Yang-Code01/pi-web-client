/**
 * 预览里的翻译对照（D241）—— 从外面走一遍：起真的桥、桩 pi 翻、改译文、同步回原文。
 *
 * 不看桥的内部字段：只走 /api/translate/*，最后读磁盘上的源文件与状态目录里的备份。
 *
 * Run: npm --prefix bridge run build && node bridge/tests/translate-e2e.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "translate-e2e");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const WORK = path.join(ROOT, "work");
const PORT = 7921;
const BASE = `http://127.0.0.1:${PORT}`;
const PI_BIN = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi-translate.mjs");
const SLUG = "doc.md";
const DOC = path.join(WORK, SLUG);

const SRC = [
  "## 対象ツール",
  "",
  "対象：注文の変更ができるかどうかを確認する。",
  "",
  "- 発注単位：元の文言を維持し、末尾に 発注No を追加する。",
  "",
  "| 元のメッセージID | 変更後の文言 |",
  "| --- | --- |",
  "| msg_a_cannot_change | 連携種別が CAS の場合、発注後に変更できません。 |",
  "| msg_b_offline | オフラインで受領した納品書を中止してください。 |",
  "",
  "```ts",
  "const msg = 'msg_a_cannot_change';",
  "```",
  "",
  "## 発注単位",
  "",
  "新規のメッセージ定数と properties 文言は、既存定義の直後に配置する。",
  "",
].join("\n");

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(DOC, SRC);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = 0;
const check = (cond, msg) => {
  if (cond) log("  ok  ", msg);
  else {
    failed += 1;
    console.error("  FAIL", msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      /* not up yet */
    }
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${what}`);
};

let bridge = null;
let cookie = "";
let ws = null;

async function startBridge() {
  bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
    cwd: REPO,
    env: {
      ...process.env,
      PI_WEB_PORT: String(PORT),
      PI_WEB_STATE: STATE,
      PI_WEB_TUNNEL: "0",
      PI_AGENT_DIR: AGENT,
      PI_BIN,
      PI_WEB_CHROME: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = [];
  bridge.stdout.on("data", (b) => out.push(b.toString()));
  bridge.stderr.on("data", (b) => out.push(b.toString()));
  bridge.on("exit", (code) => {
    if (code) console.error("bridge exited", code, out.join("").slice(-2000));
  });
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
}

async function stopBridge() {
  try {
    ws?.close();
  } catch {
    /* gone */
  }
  if (!bridge) return;
  const dead = new Promise((r) => bridge.once("exit", r));
  bridge.kill();
  await Promise.race([dead, sleep(8000)]);
  bridge = null;
}

async function login() {
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", (e) => j(new Error(`ws: ${e.message}`)));
  });
}

const post = async (name, body, headers = {}) => {
  const res = await fetch(`${BASE}/api/translate/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const get = async (url, headers = {}) => {
  const res = await fetch(`${BASE}${url}`, { headers: { cookie, ...headers } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

/** 会话要真的存在：翻译路由按会话的 cwd 认路径。 */
async function makeSession() {
  ws.send(JSON.stringify({ type: "create", cwd: WORK }));
  let id = "";
  await until(
    async () => {
      const { body } = await get("/api/sessions");
      const found = (body.sessions ?? []).find((s) => path.resolve(String(s.cwd ?? "")) === path.resolve(WORK));
      id = found?.id ?? "";
      return Boolean(id);
    },
    60000,
    "session",
  );
  return id;
}

const bars = (text) => text.split("\n").filter((l) => l.trim().startsWith("|")).map((l) => (l.match(/\|/g) ?? []).length);

try {
  await startBridge();
  await login();
  log("A. 会话 / 还没翻过 / 参数校验");

  const sessionId = await makeSession();
  check(Boolean(sessionId), `会话建好了（${sessionId.slice(0, 8)}）`);

  const before = await post("doc", { sessionId, path: SLUG, lang: "zh" });
  check(before.status === 200 && before.body.doc === null, "还没翻过：doc 为空");
  check(before.body.stale === true, "标着「过期」（没有译文）");
  check((before.body.langs ?? []).length === 4, `四种目标语言（${(before.body.langs ?? []).map((l) => String(l)).join(",")}）`);

  // D241: 默认模型是这台机器上的偏好，出厂值 copilot/gpt-6-luna，和 settings.json 无关。
  check(before.body.prefs?.model === "", "偏好里还没记模型");
  check(before.body.defaultModel === "copilot/gpt-6-luna", `出厂默认模型 copilot/gpt-6-luna（${before.body.defaultModel}）`);

  const prefs0 = await post("prefs", {});
  check(prefs0.status === 200 && prefs0.body.defaultModel === "copilot/gpt-6-luna", "不带 model 只读偏好");
  const prefsSet = await post("prefs", { model: "stub/fake-model" });
  check(prefsSet.status === 200 && prefsSet.body.prefs.model === "stub/fake-model", `记住选过的模型（${prefsSet.body.prefs.model}）`);
  const prefsBad = await post("prefs", { model: "no-slash" });
  check(prefsBad.body.prefs.model === "stub/fake-model", "不像 provider/id 的值被忽略，不覆盖已记住的");
  const prefsGet = await get("/api/translate/prefs");
  check(prefsGet.status === 200 && prefsGet.body.prefs.model === "stub/fake-model", "GET 也能读（设置页一进来就读一遍）");
  const prefsAgain = await post("doc", { sessionId, path: SLUG, lang: "zh" });
  check(prefsAgain.body.prefs?.model === "stub/fake-model", "记下来的模型下次带着 doc 一起回来");

  const badLang = await post("doc", { sessionId, path: SLUG, lang: "fr" });
  check(badLang.status === 400 && badLang.body.code === "translate_lang", `不支持的语言被拒（${badLang.body.code}）`);

  const noModel = await post("start", { sessionId, path: SLUG, lang: "zh" });
  check(noModel.status === 400 && noModel.body.code === "translate_model", `没选模型被拒（${noModel.body.code}）`);

  log("B. 翻一遍：分节、代码段不翻、表格结构保住");

  const started = await post("start", { sessionId, path: SLUG, lang: "zh", provider: "stub", model: "fake-model" });
  check(started.status === 200 && Boolean(started.body.job?.id), `任务起来了（${started.body.job?.id?.slice(0, 8)}）`);
  const id = started.body.job.id;
  let job = started.body.job;
  await until(async () => {
    job = (await get(`/api/translate/job?id=${id}`)).body.job;
    return job && job.status !== "running";
  }, 90000, "job done");
  check(job.status === "done", `翻完了（${job.status}${job.error ? `: ${job.error}` : ""}）`);
  check(job.total === 2, `按标题切成两节（total ${job.total}）`);

  const after = await post("doc", { sessionId, path: SLUG, lang: "zh" });
  const doc = after.body.doc;
  check(after.status === 200 && doc?.sections?.length === 2, "译文回到页面：两节");
  check(after.body.stale === false, "刚翻完不算过期");
  const out = doc.sections.map((s) => s.out).join("\n\n");
  check(out.includes("译 "), "每行都过了一遍模型（桩：加了「译 」前缀）");
  const prose = out
    .replace(/```[\s\S]*?```/g, "")
    .split("\n")
    .filter((l) => !/^\s*(#|```)/.test(l))
    .join("\n");
  check(!/[\u3040-\u30ff]/.test(prose), "正文里的假名都被换掉了（标题行照抄，不算）");
  check(out.includes("const msg = 'msg_a_cannot_change';"), "代码块原样留在译文里（没送给模型）");
  check(JSON.stringify(bars(out)) === JSON.stringify(bars(SRC)), `表格的行数与每行 | 数量一致（${bars(out).join("/")}）`);
  check(doc.sections[0].heading.includes("対象ツール"), "节标题留在译文里（左右靠它对位）");
  check((doc.warnings ?? []).length === 0, `没有告警（${JSON.stringify(doc.warnings)}）`);

  const srcOnDisk = fs.readFileSync(DOC, "utf8");
  check(srcOnDisk === SRC, "翻一遍不碰源文件");

  log("C. 改译文只落缓存");

  const secs = doc.sections.map((s) => ({ ...s }));
  // 人改一处：把第一节表格里那一行改个说法。
  // 人改一处：把第一节表格里那一行（msg_b_offline）改个说法，| 数量不动。
  const MARK = "作废吧";
  secs[0].out = secs[0].out.replace(/^\| msg_b_offline.*$/m, `| msg_b_offline 译 | ${MARK} 译 |`);
  check(secs[0].out !== doc.sections[0].out, "真的改到了（预备条件）");
  const joined = secs.map((s) => s.out).join("\n\n");

  const saved = await post("save", { sessionId, path: SLUG, lang: "zh", text: joined });
  check(saved.status === 200 && saved.body.doc.sections[0].out.includes(MARK), "存进去了");
  check(fs.readFileSync(DOC, "utf8") === SRC, "存译文不碰源文件（还是原文）");

  const badShape = await post("save", { sessionId, path: SLUG, lang: "zh", text: joined.replace(/^## /gm, "") });
  check(badShape.status === 400 && badShape.body.code === "translate_shape", `删标题再存会被拒（${badShape.body.code}）`);

  log("D. 同步回原文：先看差异，再写盘");

  const sync = await post("sync", { sessionId, path: SLUG, lang: "zh" });
  check(sync.status === 200 && sync.body.edits === 1, `只挑出改过的那一处（edits ${sync.body.edits}）`);
  const diff = sync.body.preview?.[0];
  check(diff && diff.before !== diff.after, `预览里能看到改动前后两块原文（${JSON.stringify(sync.body).slice(0, 500)}）`);
  check(fs.readFileSync(DOC, "utf8") === SRC, "还没点写回，源文件一个字节没动");

  const apply = await post("apply", { id: sync.body.id });
  check(apply.status === 200, `写回成功（${apply.status}${apply.body.code ? ` ${apply.body.code}` : ""}）`);
  const written = fs.readFileSync(DOC, "utf8");
  check(written.includes(MARK), "源文件里换成了新说法");
  check(written.includes("msg_a_cannot_change"), "没改的地方原样留着");
  check(JSON.stringify(bars(written)) === JSON.stringify(bars(SRC)), "写回之后表格结构没坏");
  check(Boolean(apply.body.backup) && fs.existsSync(apply.body.backup), `原文备份在（${path.basename(String(apply.body.backup))}）`);
  check(fs.readFileSync(apply.body.backup, "utf8") === SRC, "备份就是写之前的原文");

  // 写回以后缓存里的 src 必须换成新原文：不换的话对照页左边还挂着翻译那一刻的快照，
  // 用户看到的就是「提示写回了，左边没变」。
  const docAfter = (await post("doc", { sessionId, path: SLUG, lang: "zh" })).body;
  check(docAfter.stale === false, `写回后译文不再算过期（stale ${docAfter.stale}，doc ${docAfter.doc?.mtime}/${docAfter.doc?.size}，磁盘 ${fs.statSync(DOC).mtimeMs}/${fs.statSync(DOC).size}，路由 ${docAfter.mtime}/${docAfter.size}）`);
  check(docAfter.doc.sections[0].src.includes(MARK), "写回后缓存里的原文跟着换了");
  check(
    docAfter.doc.sections[0].src.split("\n")[0] === written.split("\n")[0],
    "缓存里的原文与磁盘第一行一致",
  );
  check(docAfter.doc.sections.every((sx) => sx.gen === sx.out), "写回后没有「改过」的标记了");

  const again = await post("apply", { id: sync.body.id });
  check(again.status === 404 && again.body.code === "translate_apply", `同一个 id 不能写两次（${again.status}）`);

  log("E. 原文在同步期间被改过 → 409");

  const secs2 = (await post("doc", { sessionId, path: SLUG, lang: "zh" })).body.doc.sections.map((s) => ({ ...s }));
  secs2[1].out = `${secs2[1].out}\n\n译 追记一行。`;
  await post("save", { sessionId, path: SLUG, lang: "zh", text: secs2.map((s) => s.out).join("\n\n") });
  const sync2 = await post("sync", { sessionId, path: SLUG, lang: "zh" });
  check(sync2.status === 200 && sync2.body.edits >= 1, `第二次同步也挑出了改动（edits ${sync2.body.edits}）`);
  fs.appendFileSync(DOC, "\n外部改了一下。\n");
  const conflict = await post("apply", { id: sync2.body.id });
  check(conflict.status === 409 && conflict.body.code === "translate_conflict", `原文被改过：拒绝写回（${conflict.status} ${conflict.body.code}）`);

  log("F. 公网不给翻");

  const pub = await post("doc", { sessionId, path: SLUG, lang: "zh" }, { "x-forwarded-proto": "https" });
  check(pub.status === 403 && pub.body.code === "translate_public", `隧道来的 doc 请求被拒（${pub.status} ${pub.body.code}）`);
  const pubStart = await post("start", { sessionId, path: SLUG, lang: "zh", provider: "stub", model: "fake-model" }, { "x-forwarded-proto": "https" });
  check(pubStart.status === 403 && pubStart.body.code === "translate_public", `隧道来的 start 请求被拒（${pubStart.status}）`);

  log("G. 更新只重翻变了的节（桩会记下每次调用的次数）");
  const updBefore = (await post("doc", { sessionId, path: SLUG, lang: "zh" })).body.doc.sections.map((s) => s.gen);
  fs.writeFileSync(DOC, SRC.replace("- 発注単位", "- 発注単位（追記）"));
  const updJob = (await post("start", { sessionId, path: SLUG, lang: "zh", provider: "stub", model: "fake-model" })).body.job;
  await until(async () => {
    const j = (await get(`/api/translate/job?id=${updJob.id}`)).body.job;
    return j && j.status !== "running";
  }, 90000, "update done");
  const updDoc = (await post("doc", { sessionId, path: SLUG, lang: "zh" })).body.doc;
  check(updDoc.sections[0].src.includes("追記"), "新原文被收下");
  check(updDoc.sections[1].gen === updBefore[1], "没变的第二节没有重翻（gen 还是上一版）");
  check(updDoc.sections[0].gen !== updBefore[0], "变了的第二节重翻了");

  log("H. 取消 / 过期任务");
  const cancelled = (await post("start", { sessionId, path: SLUG, lang: "zh", provider: "stub", model: "fake-model", force: true })).body.job;
  const stop = await post("cancel", { id: cancelled.id });
  check(stop.status === 200 && stop.body.ok === true, `取消任务（${JSON.stringify(stop.body)}）`);
  const gone = await get(`/api/translate/job?id=${encodeURIComponent("nope")}`);
  check(gone.status === 404 && gone.body.code === "translate_job", `查不到的任务 404（${gone.status}）`);
} catch (err) {
  failed += 1;
  console.error("  FAIL", String(err?.stack ?? err));
} finally {
  await stopBridge();
  if (failed) {
    console.error(`\n${failed} 处失败`);
    process.exit(1);
  }
  console.log("\n全部通过");
}
