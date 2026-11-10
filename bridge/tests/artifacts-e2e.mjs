/**
 * D208 产物接口的边界，跑在它自己的临时 bridge 上（绝不碰 7864 那份）。
 *
 *   node bridge/tests/artifacts-e2e.mjs
 *
 * 这里只测「谁能调」和「叫错会话怎么答」：真正的基线读取在 artifacts-unit.mjs 里，
 * 而「写完文件后弹窗是什么样」要真跑一个模型回合，那是手工验收的事（PR 里写清楚了）。
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "../../tools/paths.mjs";

const ROOT = REPO;
const DIST = path.join(ROOT, "bridge", "dist", "index.js");
const PORT = Number(process.env.ARTIFACTS_E2E_PORT ?? 7893);
const STATE = process.env.ARTIFACTS_E2E_STATE ?? path.join(ROOT, ".scratch", "artifacts-e2e-state");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "artifacts-e2e-pass";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
}

fs.rmSync(STATE, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
const env = { ...process.env, PI_WEB_STATE: STATE, PI_WEB_PORT: String(PORT), PI_WEB_HOST: "127.0.0.1", PI_WEB_TUNNEL: "0", PI_WEB_ROOT: path.join(ROOT, "web", "dist") };
// --passphrase 只改口令然后退出（bridge/src/index.ts:358），不能拿它起常驻进程。
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
const child = spawn(process.execPath, [DIST], { env, stdio: ["ignore", "pipe", "pipe"] });
let bridgeLog = "";
child.stdout.on("data", (b) => (bridgeLog += b.toString()));
child.stderr.on("data", (b) => (bridgeLog += b.toString()));

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return true;
    } catch {
      /* not yet */
    }
    await sleep(150);
  }
  throw new Error(`bridge did not come up:
${bridgeLog}`);
}

let cookie = "";
const post = (p, body) =>
  fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

try {
  await waitUp();
  check("bridge 起来了", true);

  // 回环也要 cookie：闸门之后的 /api/artifacts/* 与 /api/git 都要它。
  const login = await post("/api/login", { passphrase: PASS });
  cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  check("登录拿到 cookie", login.ok && Boolean(cookie), String(login.status));

  // ---- snapshot：只认回环 + 会话 token，没 token / 假 token 都是 403。
  let res = await post("/api/artifacts/snapshot", { path: "package.json" });
  check("snapshot 没 token → 403", res.status === 403, String(res.status));

  res = await post("/api/artifacts/snapshot", { path: "package.json", token: "not-a-real-token" });
  const body = await res.json();
  check("snapshot 假 token → 403 bad-token", res.status === 403 && body.reason === "bad-token", JSON.stringify(body));

  // ---- list：本机回环不强制 cookie，但会话必须存在。
  res = await post("/api/artifacts/list", { sessionId: "nope", items: [{ path: "a.ts", tool: "write", writes: 1 }] });
  const listBody = await res.json();
  check("list 未知会话 → 404 session_not_found", res.status === 404 && listBody.code === "session_not_found", JSON.stringify(listBody));

  // ---- diff：同上。
  res = await post("/api/artifacts/diff", { sessionId: "nope", path: "a.ts" });
  const diffBody = await res.json();
  check("diff 未知会话 → 404", res.status === 404 && diffBody.code === "session_not_found", JSON.stringify(diffBody));

  // ---- 老接口没被挡住：cookie 闸之后的路由仍然可达。
  res = await fetch(`${BASE}/api/git?dir=${encodeURIComponent(ROOT)}`, { headers: { cookie } });
  check("/api/git 仍然可用", res.status === 200, String(res.status));
} finally {
  child.kill();
  fs.rmSync(STATE, { recursive: true, force: true });
}

const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} 项失败` : "\nartifacts-e2e: all passed");
process.exit(bad.length ? 1 : 0);
