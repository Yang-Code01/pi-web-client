/**
 * 会话列表的昵称回退（P3）：对方离线、最后一条是我发的时，名字要从通讯录取。
 *
 * 以前 `History.threads()` 只看「在线表」和「最后一条的 from」——最后一条是我发的，
 * `from` 就是 null，于是昵称变成 nodeId 前 8 位，主机名和端口也丢了。
 *
 * 用法：node bridge/tests/peer-history.mjs   （先 npm run build:peer）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(here, "..", "..", "peer", "dist", "index.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "peer-history-"));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!fs.existsSync(ENTRY)) {
  console.error(`没找到 ${ENTRY}：先跑 npm run build:peer`);
  process.exit(1);
}

const ME = "11111111-1111-4111-8111-111111111111";
const PEER = "aaaaaaaa-1111-4111-8111-111111111111";
const PORT = 17971;
const state = path.join(ROOT, "state");
fs.mkdirSync(path.join(state, "history"), { recursive: true });

const at = Date.now() - 60_000;
const theirs = {
  id: "00000000-0000-4000-8000-000000000001",
  at,
  from: { nodeId: PEER, nickname: "小王", hostname: "xiaowang-pc", port: 7865 },
  to: { kind: "node", id: ME },
  kind: "text",
  text: "他先说的",
};
// 最后一条是我发的：`from` 是我，所以 threads() 里那个「最后一条的 from」回退取不到名字。
const mine = {
  id: "00000000-0000-4000-8000-000000000002",
  at: at + 1000,
  from: { nodeId: ME, nickname: "我", hostname: "probe", port: PORT },
  to: { kind: "node", id: PEER },
  kind: "text",
  text: "我回的最后一句",
};
fs.writeFileSync(path.join(state, "history", `${PEER}.jsonl`), `${JSON.stringify(theirs)}\n${JSON.stringify(mine)}\n`);
// 通讯录里记着他：离线也要能用这个名字。
fs.writeFileSync(
  path.join(state, "peers.json"),
  JSON.stringify({
    [PEER]: { nickname: "小王", hostname: "xiaowang-pc", port: 7865, friend: true, favorite: false, incoming: false, outgoing: false, at },
  }),
);

const child = spawn(process.execPath, [ENTRY], {
  env: {
    ...process.env,
    PI_PEER_STATE: state,
    PI_PEER_PORT: String(PORT),
    PI_PEER_ANNOUNCE_PORT: "17972",
    PI_PEER_NICKNAME: "probe",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (b) => process.env.PEER_E2E_VERBOSE && process.stdout.write(`[peer] ${b}`));
child.stderr.on("data", (b) => process.stdout.write(`[peer!] ${b}`));

let failed = null;
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try {
      up = (await fetch(`http://127.0.0.1:${PORT}/status`, { signal: AbortSignal.timeout(800) })).ok;
    } catch {
      /* 还没起来 */
    }
    if (!up) await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) throw new Error("peer 没起来");

  const body = await (await fetch(`http://127.0.0.1:${PORT}/threads`)).json();
  if (body.threads?.length !== 1) throw new Error(`应有 1 个会话，实际 ${JSON.stringify(body)}`);
  const t = body.threads[0];
  if (t.nickname !== "小王") throw new Error(`昵称应回退到通讯录的「小王」，实际「${t.nickname}」`);
  if (t.hostname !== "xiaowang-pc") throw new Error(`主机名应来自通讯录，实际「${t.hostname}」`);
  if (t.port !== 7865) throw new Error(`端口应来自通讯录，实际 ${t.port}`);
  if (t.online !== false) throw new Error("他离线，online 应为 false");
  if (t.count !== 2) throw new Error(`文字条数应为 2，实际 ${t.count}`);
  if (t.last?.text !== "我回的最后一句") throw new Error(`最后一条不对：${JSON.stringify(t.last)}`);
  log(`ok 会话名「${t.nickname}」（${t.hostname}:${t.port}），最后一条是我发的也不掉成 uuid`);
} catch (err) {
  failed = err;
  console.error(`失败：${err?.message ?? err}`);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 200));
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows 上子进程可能还攥着文件 */
  }
  if (failed) process.exit(1);
  log("peer-history 全过");
  process.exit(0);
}
