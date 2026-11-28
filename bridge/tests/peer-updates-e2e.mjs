/**
 * D441 只读更新组：peer 协议这一层的端到端（不经过 bridge 的发布者逻辑）。
 *
 * 三个真 peer 共用一个组播端口：
 *   P = 发布者（config 里 `updates.repo` + `publisher:true`）
 *   A = 成员（同仓库）
 *   C = 换机器后的新发布者（同仓库，本机没有那个组）
 *
 * 验的是这几件事：
 *   1. announce 带得出 `updates.repo` / `publisher`（成员凭它被认出来）。
 *   2. 只读门：成员发 text / react / pin / 撤回全部 403，发布者照常。
 *   3. 公告 payload 原样到成员那边（`kind` 仍是 text，旧版本只会把它当普通消息）。
 *   4. 退群 = opt-out：快照不再合、公告不再进；`rejoin` 之后能被重新拉回来。
 *   5. 换机器：新发布者从 v=1 的快照接管，旧成员认它（v 抬到 before.v+1）。
 *
 * 用法：npm run build:peer && node bridge/tests/peer-updates-e2e.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(here, "..", "..", "peer", "dist", "index.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "peer-updates-"));
const REPO = "yang-code01/pi-web-client";
const GROUP = "grp-updates-yang-code01-pi-web-client";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!fs.existsSync(ENTRY)) {
  console.error(`没找到 ${ENTRY}：先跑 npm run build:peer`);
  process.exit(1);
}

const procs = [];
function start(name, port, announce, extra = {}) {
  const state = path.join(ROOT, name);
  fs.mkdirSync(state, { recursive: true });
  if (extra.config) fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(extra.config));
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      PI_PEER_STATE: state,
      PI_PEER_PORT: String(port),
      PI_PEER_ANNOUNCE_PORT: String(announce),
      PI_PEER_NICKNAME: extra.nickname ?? name,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => {
    if (process.env.PEER_E2E_VERBOSE) process.stdout.write(`[${name}] ${b}`);
  });
  child.stderr.on("data", (b) => process.stdout.write(`[${name}!] ${b}`));
  procs.push(child);
  return child;
}
process.on("exit", () => {
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* 已经退了 */
    }
  }
});

const get = async (port, p) => (await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(3000) })).json();
async function post(port, p, body, expect = 200) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status !== expect) throw new Error(`POST ${p} 期望 ${expect}，拿到 ${res.status}：${JSON.stringify(data)}`);
  return data;
}

let failed = 0;
function ok(label) {
  log("✔", label);
}
function bad(label, detail) {
  failed++;
  console.error("✘", label, detail ?? "");
}

async function waitFor(label, fn, timeout = 20_000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`等不到「${label}」：${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

async function messages(port, peer) {
  const data = await get(port, `/messages?peer=${encodeURIComponent(peer)}&limit=100`);
  return data.entries ?? data.messages ?? [];
}

async function main() {
  const P = 7881;
  const A = 7882;
  const C = 7883;
  start("pub", P, 7981, { config: { updates: { repo: REPO, publisher: true } } });
  start("mem", A, 7981, { config: { updates: { repo: REPO, publisher: false } } });

  const pMe = await waitFor("发布者起来", () => get(P, "/status"));
  const aMe = await waitFor("成员起来", () => get(A, "/status"));

  // 1. announce 带出仓库标识（成员靠它被发布者认出来；换机器也一样）。
  const seen = await waitFor("发布者看见成员", async () => {
    const st = await get(P, "/status");
    return st.online?.find((p) => p.nodeId === aMe.nodeId);
  });
  if (seen.updates?.repo === REPO) ok("announce 带得出 updates.repo");
  else bad("announce 没带出 updates.repo", seen.updates);

  // 2. 发布者建只读组并把成员拉进来。
  const created = await post(P, "/groups", {
    action: "create",
    id: GROUP,
    name: `${REPO} 更新`,
    members: [aMe.nodeId],
    announceOnly: true,
    publisher: pMe.nodeId,
  });
  if (created.group?.announceOnly === true && created.group?.publisher === pMe.nodeId) ok("建出只读组");
  else bad("建组字段不对", created.group);

  const aThread = await waitFor("成员收到组快照", async () => {
    const data = await get(A, "/threads");
    return (data.threads ?? []).find((t) => t.nodeId === GROUP && t.group);
  });
  if (aThread.group.announceOnly === true && aThread.group.publisher === pMe.nodeId) ok("成员收到 announceOnly + publisher");
  else bad("成员那边的组字段不对", aThread.group);

  // 3. 只读门：成员什么都发不了。
  for (const [label, payload] of [
    ["文字", { action: "send", peer: GROUP, text: "我也说一句" }],
  ]) {
    const r = await fetch(`http://127.0.0.1:${A}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    const data = await r.json().catch(() => ({}));
    if ((r.status === 403 || r.status === 400) && String(data.error ?? "").includes("只读")) ok(`成员发${label}被拒`);
    else bad(`成员发${label}没被拒`, { status: r.status, data });
  }

  // 4. 发布者发公告：payload 原样到成员那边，kind 仍是 text。
  const batch = { title: "2026-11-28 · 局域网更新组（#730）", body: "### 新增\n\n- 固定只读更新组\n" };
  await post(P, "/send", {
    peer: GROUP,
    text: `${REPO} 更新到 abc1234（2026-11-28）\n\n· ${batch.title}`,
    announce: { repo: REPO, commit: "abc1234", batches: [batch], howTo: "auto" },
  });
  const got = await waitFor("成员收到公告", async () => {
    const list = await messages(A, GROUP);
    return list.find((e) => e.announce?.commit === "abc1234");
  });
  if (got.kind === "text" && got.announce?.batches?.[0]?.title === batch.title) ok("公告 payload 原样到达，kind 仍是 text");
  else bad("公告 payload 不对", got.announce);

  // 5. 退群 = opt-out：发布者再发也不进来。
  await post(A, "/groups", { action: "leave", id: GROUP });
  const left = await waitFor("本机标成已退出", async () => {
    const data = await get(A, "/threads");
    return (data.threads ?? []).find((t) => t.nodeId === GROUP)?.group?.left;
  });
  if (left === true) ok("退群后本机标 left");
  else bad("退群没生效", left);

  const before = (await messages(A, GROUP)).length;
  await post(P, "/send", {
    peer: GROUP,
    text: `${REPO} 更新到 def5678（2026-11-28）`,
    announce: { repo: REPO, commit: "def5678", batches: [batch], howTo: "auto" },
  });
  await new Promise((r) => setTimeout(r, 1200));
  const after = await messages(A, GROUP);
  if (after.length === before) ok("退群后公告不再进来（opt-out 拦住了快照）");
  else bad("退群后还收到了公告", { before, after: after.length });

  // 6. rejoin + 邀请 = 回到组里。
  await post(A, "/groups", { action: "rejoin", id: GROUP });
  await post(P, "/groups", { action: "invite", id: GROUP, members: [aMe.nodeId] });
  const back = await waitFor("重新进组", async () => {
    const data = await get(A, "/threads");
    return (data.threads ?? []).find((t) => t.nodeId === GROUP)?.group?.left === false;
  });
  if (back) ok("rejoin + 邀请后重新进组");
  else bad("重新加入没生效");

  // 7. 换机器：C 的本机没有这个组，从 v=1 接管；旧成员（v 更大）必须认它。
  start("pub2", C, 7981, { config: { updates: { repo: REPO, publisher: true } } });
  const cMe = await waitFor("新发布者起来", () => get(C, "/status"));
  await waitFor("新发布者看见成员", async () => {
    const st = await get(C, "/status");
    return st.online?.some((p) => p.nodeId === aMe.nodeId);
  });
  const made = await post(C, "/groups", {
    action: "create",
    id: GROUP,
    name: `${REPO} 更新`,
    members: [aMe.nodeId],
    announceOnly: true,
    publisher: cMe.nodeId,
  });
  if (made.group?.v === 1) ok("新机器的快照 v=1");
  else bad("新机器建组版本不是 1", made.group?.v);

  const taken = await waitFor("成员接受接管", async () => {
    const data = await get(A, "/threads");
    const t = (data.threads ?? []).find((x) => x.nodeId === GROUP);
    return t?.group?.publisher === cMe.nodeId ? t.group : null;
  });
  // `/threads` 不暴露 v，直接看成员的状态文件：接管必须把版本抬到「旧 v + 1」。
  const memberState = JSON.parse(fs.readFileSync(path.join(ROOT, "mem", "groups.json"), "utf8"));
  const memberGroup = memberState.find((g) => g.id === GROUP);
  if (memberGroup?.v > 1 && taken.publisher === cMe.nodeId) ok(`接管后版本抬到 ${memberGroup.v}（旧成员 v 更大也收）`);
  else bad("接管后版本没抬", memberGroup?.v);

  await post(C, "/send", {
    peer: GROUP,
    text: `${REPO} 更新到 9999999（2026-11-28）`,
    announce: { repo: REPO, commit: "9999999", batches: [batch], howTo: "auto" },
  });
  const fromNew = await waitFor("成员收到新发布者的公告", async () => {
    const list = await messages(A, GROUP);
    return list.find((e) => e.announce?.commit === "9999999");
  });
  if (fromNew.from.nodeId === cMe.nodeId) ok("新发布者的公告成员收得到");
  else bad("新发布者的公告来源不对", fromNew.from);
}

main()
  .catch((err) => {
    failed++;
    console.error("✘", err.message);
  })
  .finally(() => {
    log(failed ? `失败 ${failed} 项` : "全部通过");
    process.exit(failed ? 1 : 0);
  });
