/**
 * Probe: the file explorer's save path (D50) against the real bridge.
 *
 * Covers: a text file opened through /api/preview becomes writable, the optimistic lock (mtime +
 * size) refuses a file pi changed meanwhile with 409, `copy: true` writes a sibling instead, paths
 * that were never opened are refused with 403, >2 MB is refused with 400, binary files are never
 * writable, a UTF-8 BOM survives a round trip, and no `.tmp-*` files are left behind.
 *
 * Run: node bridge/tests/save-check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const PORT = 7879;
const ROOT = "F:/pi-web-client/.scratch/save-check";
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const WORK = path.join(ROOT, "work");
const BASE = `http://127.0.0.1:${PORT}`;
const SID = "zz-save-check";

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, SESSIONS, WORK]) fs.mkdirSync(d, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A session file pi itself would accept: header row + one user message, cwd = WORK. */
function mkSession(id, cwd) {
  const dir = path.join(SESSIONS, `--${id}--`);
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const rows = [
    { type: "session", version: 3, id, timestamp: at, cwd },
    { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "编辑保存测试" }] } },
  ];
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}
mkSession(SID, WORK);

// The file the happy path edits: starts with a UTF-8 BOM to prove it survives.
const MD = path.join(WORK, "笔记.md");
const BOM = "\ufeff";
fs.writeFileSync(MD, `${BOM}# 标题\n\n原文\n`, "utf8");
const TXT = path.join(WORK, "plain.txt");
fs.writeFileSync(TXT, "hello\n", "utf8");
const BIG = path.join(WORK, "big.md");
fs.writeFileSync(BIG, `# 大文件\n\n${"x".repeat(2 * 1024 * 1024 + 10)}\n`, "utf8");
const IMG = path.join(WORK, "shot.png");
fs.writeFileSync(IMG, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));
const NEVER = path.join(WORK, "never-opened.md");
fs.writeFileSync(NEVER, "# 没打开过\n", "utf8");

let bridge = null;
const bridgeOut = [];
const start = () => {
  bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
    cwd: "F:/pi-web-client",
    env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0", PI_AGENT_DIR: AGENT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
  bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));
};

async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(200);
  }
  console.error(bridgeOut.join("").slice(-2000));
  assert(false, `timeout waiting for ${label}`);
}

let cookie = "";
async function connect() {
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
}

const post = async (url, body) => {
  const res = await fetch(`${BASE}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
};
const preview = (p) => post("/api/preview", { sessionId: SID, path: p });
const save = (body) => post("/api/save", { sessionId: SID, ...body });
const tmpLeft = () => fs.readdirSync(WORK).filter((n) => n.includes(".tmp-"));

try {
  start();
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 15000, "passphrase");
  await connect();

  // ---- 1. 打开过的文本文件可以写
  const p1 = await preview(MD);
  assert(p1.status === 200, `preview md ok (${p1.status} ${JSON.stringify(p1.data)})`);
  assert(p1.data.kind === "markdown", `kind markdown (got ${p1.data.kind})`);
  const r1 = await save({ path: MD, text: "# 标题\n\n改过了\n", mtime: p1.data.mtime, size: p1.data.size });
  assert(r1.status === 200, `save ok (${r1.status} ${JSON.stringify(r1.data)})`);
  assert(fs.readFileSync(MD, "utf8") === `${BOM}# 标题\n\n改过了\n`, "content written");
  assert(fs.readFileSync(MD, "utf8").charCodeAt(0) === 0xfeff, "BOM preserved");
  assert(tmpLeft().length === 0, `no .tmp-* left behind (got ${tmpLeft().join(",")})`);
  log("1 save ok, BOM kept, mtime", r1.data.mtime);

  // ---- 2. 返回的新 mtime/size 可以直接接着保存
  const r2 = await save({ path: MD, text: "# 标题\n\n再改一次\n", mtime: r1.data.mtime, size: r1.data.size });
  assert(r2.status === 200, `second save with returned mtime ok (${r2.status})`);
  log("2 chained save ok");

  // ---- 3. pi 中途改过 → 409，磁盘内容不动
  const p3 = await preview(TXT);
  assert(p3.status === 200, "preview txt ok");
  fs.writeFileSync(TXT, "pi 改的\n", "utf8");
  const st3 = fs.statSync(TXT);
  const r3 = await save({ path: TXT, text: "我的版本\n", mtime: st3.mtimeMs - 5000, size: st3.size });
  assert(r3.status === 409, `conflict is 409 (got ${r3.status} ${JSON.stringify(r3.data)})`);
  assert(fs.readFileSync(TXT, "utf8") === "pi 改的\n", "disk untouched after 409");
  log("3 conflict 409 ok");

  // ---- 4. copy:true 另存副本，原文件不动
  const r4 = await save({ path: TXT, text: "我的版本\n", mtime: st3.mtimeMs, size: st3.size, copy: true });
  assert(r4.status === 200, `copy ok (${r4.status} ${JSON.stringify(r4.data)})`);
  const copyPath = r4.data.path;
  assert(path.basename(copyPath) === "plain.copy.txt", `copy name (got ${path.basename(copyPath)})`);
  assert(fs.readFileSync(copyPath, "utf8") === "我的版本\n", "copy content");
  assert(fs.readFileSync(TXT, "utf8") === "pi 改的\n", "original untouched by copy");
  log("4 copy ok →", path.basename(copyPath));

  // ---- 5. 从没打开过的路径 → 403
  const r5 = await save({ path: NEVER, text: "x\n", mtime: Date.now(), size: 1 });
  assert(r5.status === 403, `unopened path is 403 (got ${r5.status})`);
  assert(fs.readFileSync(NEVER, "utf8") === "# 没打开过\n", "unopened file untouched");
  log("5 403 for unopened path ok");

  // ---- 6. 超 2MB → 400
  const p6 = await preview(BIG);
  assert(p6.status === 200, `preview big ok (${p6.status})`);
  const r6 = await save({ path: BIG, text: "y".repeat(2 * 1024 * 1024 + 5), mtime: p6.data.mtime, size: p6.data.size });
  assert(r6.status === 400, `oversize body is 400 (got ${r6.status})`);
  log("6 oversize 400 ok");

  // ---- 7. 图片（binary）永远不可写
  const p7 = await preview(IMG);
  assert(p7.status === 200 && p7.data.kind === "image", `preview image (${p7.status} ${p7.data?.kind})`);
  const r7 = await save({ path: IMG, text: "not an image", mtime: p7.data.mtime, size: p7.data.size });
  assert(r7.status === 403, `image save is 403 (got ${r7.status})`);
  log("7 image not writable ok");

  // ---- 8. 会话不存在 → 404
  const r8 = await post("/api/save", { sessionId: "nope", path: MD, text: "x", mtime: 0, size: 0 });
  assert(r8.status === 404, `unknown session is 404 (got ${r8.status})`);

  // ---- 9. 全盘可读：会话 cwd 之外的文件也能预览（D50）
  const OUTSIDE = path.join(ROOT, "outside.md");
  fs.writeFileSync(OUTSIDE, "# 外面\n", "utf8");
  const p9 = await preview(OUTSIDE);
  assert(p9.status === 200, `preview outside cwd ok (${p9.status} ${JSON.stringify(p9.data)})`);
  const r9 = await save({ path: OUTSIDE, text: "# 外面\n改\n", mtime: p9.data.mtime, size: p9.data.size });
  assert(r9.status === 200, `outside cwd save ok (${r9.status})`);
  log("9 outside-cwd read+write ok");

  log("ALL PASS");
} catch (err) {
  console.error(bridgeOut.join("").slice(-3000));
  throw err;
} finally {
  bridge?.kill();
}
