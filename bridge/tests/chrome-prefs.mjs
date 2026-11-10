/**
 * 按钮可见性（#281 / #288）：桥端那份 `ui.json` 的 `chrome` 三态。
 *
 * 覆盖：旧 `showExtButton` 的迁移、白名单过滤、`null`/`undefined` 删键、写盘只留 `chrome`、
 * `hello` 带回、`ui.set` 落盘并广播、公网连接先 step-up。裸 `undefined` 走不了 JSON，所以线上
 * 用 `null` 表达「删掉这个键」，两者在 `writeUiPrefs` 里同义。
 *
 *   npm run build:bridge && node bridge/tests/chrome-prefs.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 7921;
const ROOT = path.join(REPO, ".scratch", "chrome-prefs");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const BASE = `http://127.0.0.1:${PORT}`;
const UI = path.join(STATE, "ui.json");

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });

process.env.PI_WEB_STATE = STATE;
const extmgr = await import("../dist/extmgr.js");

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = false;
const check = (cond, msg) => {
  if (cond) log("  ok  ", msg);
  else {
    failed = true;
    console.error("  FAIL", msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const disk = () => JSON.parse(fs.readFileSync(UI, "utf8"));
const put = (obj) => fs.writeFileSync(UI, JSON.stringify(obj));

// ------------------------------------------------------------------ A. 读盘 / 迁移 / 写盘
log("A. ui.json 的三态与迁移");
put({ showExtButton: false });
let p = extmgr.readUiPrefs();
check(p.chrome.ext === false && p.showExtButton === false, `旧文件只有 showExtButton:false → chrome.ext 被认下来 (${JSON.stringify(p.chrome)})`);

put({ showExtButton: true });
p = extmgr.readUiPrefs();
check(p.chrome.ext === undefined && p.showExtButton === true, "旧文件 showExtButton:true → 不落 ext 键");

put({ chrome: { terminal: false }, showExtButton: false });
p = extmgr.readUiPrefs();
check(p.chrome.terminal === false && p.chrome.ext === undefined && p.showExtButton === true, `chrome 一旦出现，showExtButton 不再是数据源 (${JSON.stringify(p.chrome)})`);

put({ chrome: {}, showExtButton: false });
p = extmgr.readUiPrefs();
check(p.showExtButton === true, "chrome 是空对象也算「新字典已出现」，旧字段不再影响扩展按钮");

put({});
extmgr.writeUiPrefs({ chrome: { terminal: false, look: false, peer: "yes", nonsense: true } });
check(JSON.stringify(disk()) === JSON.stringify({ chrome: { terminal: false } }), `白名单过滤未知 id 与非布尔，只写 chrome (${JSON.stringify(disk())})`);
check(disk().showExtButton === undefined, "派生值 showExtButton 不落盘");

p = extmgr.writeUiPrefs({ chrome: { terminal: undefined } });
check(p.chrome.terminal === undefined && JSON.stringify(disk().chrome) === "{}", "写入 undefined 删除该键（回到默认）");

extmgr.writeUiPrefs({ chrome: { files: true, notes: false } });
p = extmgr.writeUiPrefs({ showExtButton: false });
check(p.chrome.ext === false && p.chrome.files === true && p.chrome.notes === false, `旧报文 showExtButton 映射进 chrome.ext，其余键不动 (${JSON.stringify(p.chrome)})`);
check(JSON.stringify(disk()) === JSON.stringify({ chrome: { files: true, notes: false, ext: false } }), `写盘只有 chrome (${JSON.stringify(disk())})`);
p = extmgr.writeUiPrefs({ chrome: { ext: true } });
check(p.chrome.ext === true && p.showExtButton === true, "chrome.ext = true → 派生值 true");

// ------------------------------------------------------------------ B. WS 协议
log("B. hello / ui.set / 广播");
fs.rmSync(UI, { force: true });
delete process.env.PI_BIN;
const env = { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0", PI_AGENT_DIR: AGENT, PI_CODING_AGENT_DIR: AGENT };
const bridgeOut = [];
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));
const until = async (fn, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(150);
  }
  throw new Error(`timeout: ${label}`);
};
const pages = [];
async function page(cookie, headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie, ...headers } });
  const seen = [];
  const waits = [];
  ws.on("message", (buf) => {
    const m = JSON.parse(buf.toString());
    seen.push(m);
    for (const w of [...waits]) {
      if (w.pred(m)) {
        waits.splice(waits.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  });
  await new Promise((r) => ws.on("open", r));
  const waitFor = (pred, ms, what, from = 0) => {
    const hit = seen.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        waits.splice(waits.indexOf(w), 1);
        reject(new Error(`timeout: ${what}`));
      }, ms);
      waits.push(w);
    });
  };
  const ask = async (m, pred, what, ms = 10000) => {
    const mark = seen.length;
    ws.send(JSON.stringify(m));
    return waitFor(pred, ms, what, mark);
  };
  pages.push(ws);
  return { ws, seen, waitFor, ask };
}
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: pass }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const a = await page(cookie);
  const hello = await a.waitFor((m) => m.type === "hello", 5000, "hello");
  check(hello.ui?.chrome && JSON.stringify(hello.ui.chrome) === "{}", `hello 带 chrome（默认空字典）(${JSON.stringify(hello.ui?.chrome)})`);
  check(hello.ui?.showExtButton === true, "hello 仍带派生值 showExtButton");

  let ui = await a.ask({ type: "ui.set", chrome: { terminal: false } }, (m) => m.type === "ui", "ui.set off");
  check(ui.ui.chrome.terminal === false && ui.ui.showExtButton === true, `ui.set 写入 terminal:false 并回 ui (${JSON.stringify(ui.ui.chrome)})`);
  check(JSON.stringify(disk()) === JSON.stringify({ chrome: { terminal: false } }), `落盘只有 chrome (${JSON.stringify(disk())})`);

  const b = await page(cookie);
  const helloB = await b.waitFor((m) => m.type === "hello", 5000, "hello b");
  check(helloB.ui?.chrome.terminal === false, "另一台连上来，hello 带回同一份");

  const onB = b.waitFor((m) => m.type === "ui" && m.ui.chrome.terminal === true, 5000, "broadcast");
  ui = await a.ask({ type: "ui.set", chrome: { terminal: true } }, (m) => m.type === "ui", "ui.set on");
  await onB;
  check(ui.ui.chrome.terminal === true, "改成 true 后广播给所有连接");

  ui = await a.ask({ type: "ui.set", chrome: { terminal: null } }, (m) => m.type === "ui", "ui.set delete");
  check(!Object.prototype.hasOwnProperty.call(ui.ui.chrome, "terminal"), "null（线上表达 undefined）删掉该键");
  check(JSON.stringify(disk()) === JSON.stringify({ chrome: {} }), `磁盘同步删除 (${JSON.stringify(disk())})`);

  ui = await a.ask({ type: "ui.set", chrome: { look: false, nonsense: false, peer: "yes" } }, (m) => m.type === "ui", "ui.set whitelist");
  check(JSON.stringify(ui.ui.chrome) === "{}" && JSON.stringify(disk()) === JSON.stringify({ chrome: {} }), "白名单外的 id 与非布尔值都不会写进文件");

  ui = await a.ask({ type: "ui.set", showExtButton: false }, (m) => m.type === "ui", "ui.set legacy");
  check(ui.ui.chrome.ext === false && ui.ui.showExtButton === false, `旧报文写进 chrome.ext (${JSON.stringify(ui.ui.chrome)})`);
  check(disk().showExtButton === undefined && JSON.stringify(disk()) === JSON.stringify({ chrome: { ext: false } }), "写盘不再出现旧字段");

  ui = await a.ask({ type: "ui.set", chrome: { ext: true } }, (m) => m.type === "ui", "ui.set ext");
  check(ui.ui.chrome.ext === true && ui.ui.showExtButton === true, "chrome.ext 恢复后派生值跟着变");

  const pub = await page(cookie, { "cf-connecting-ip": "203.0.113.9" });
  await pub.waitFor((m) => m.type === "hello", 5000, "hello pub");
  const before = fs.readFileSync(UI, "utf8");
  const refused = await pub.ask({ type: "ui.set", chrome: { terminal: false } }, (m) => m.type === "need-stepup", "public ui.set");
  check(refused.type === "need-stepup" && fs.readFileSync(UI, "utf8") === before, "公网连接先要 step-up，文件不动");
} catch (e) {
  failed = true;
  console.error("ERROR", e.message);
  console.error(bridgeOut.join("").slice(-3000));
} finally {
  for (const w of pages) {
    try {
      w.close();
    } catch {}
  }
  bridge.kill();
}
log(failed ? "FAILED" : "PASS");
process.exit(failed ? 1 : 0);
