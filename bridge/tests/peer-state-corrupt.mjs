/**
 * 内网通状态文件损坏时的回归测试（fix/audit-critical-high，审计 H2/H3/H4/M12）。
 *
 * 旧行为：`load()` 把「文件不存在」和「解析失败」都当成空表，第一次保存就把盘上的真数据
 * 整份覆盖 —— 一次断电截断 = outbox 里所有离线消息、好友表、会话置顶/草稿全没。
 *
 * 现在：解析失败先原地留档为 `<file>.corrupt-<时间>`，再从空表起步；留档失败才暂停落盘。
 *   1. outbox 截断 → 队列为空，但原字节在 `.corrupt-*` 里；
 *   2. 随后 add() 只写新消息，备份仍在；
 *   3. peers 截断 → quickAdd 只留新联系人，旧文件有备份；
 *   4. threads 截断 → patch 只留新会话，旧文件有备份；
 *   5. 合法文件照常读入（别把正常路径改坏）。
 *
 * 用法：node bridge/tests/peer-state-corrupt.mjs   （先 npm run build:peer）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.PEER_DIST || path.resolve(here, "..", "..", "peer", "dist");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "peer-state-corrupt-"));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = 0;
const check = (ok, what, extra = "") => {
  if (ok) log(`ok   ${what}`);
  else {
    failed += 1;
    console.error(`FAIL ${what} ${extra}`);
  }
};

if (!fs.existsSync(path.join(DIST, "outbox.js"))) {
  console.error(`没找到 ${DIST}/outbox.js：先跑 npm run build:peer`);
  process.exit(2);
}

process.env.PI_PEER_STATE = path.join(ROOT, "state");
fs.mkdirSync(process.env.PI_PEER_STATE, { recursive: true });

const { Outbox } = await import(pathToFileURL(path.join(DIST, "outbox.js")).href);
const { Relations } = await import(pathToFileURL(path.join(DIST, "peers.js")).href);
const { Threads } = await import(pathToFileURL(path.join(DIST, "threads.js")).href);
const stateFile = (name) => path.join(process.env.PI_PEER_STATE, name);
const backupOf = (name) => {
  const entries = fs.readdirSync(process.env.PI_PEER_STATE).filter((f) => f.startsWith(`${name}.corrupt-`));
  assert.equal(entries.length, 1, `${name} 应恰好留档一份，实际 ${entries.join(", ") || "无"}`);
  return path.join(process.env.PI_PEER_STATE, entries[0]);
};
const never = () => new Promise(() => {});

// ---------------------------------------------------------------- 1 + 2. outbox
{
  const original = `[{"id":"m1","peerId":"P","addr":"10.0.0.1","port":1,"kind":"text","payload":{"text":"一"},"at":1,"tries":0,"nextAt":0},{"id":"m2","peerId":"P"`;
  fs.writeFileSync(stateFile("outbox.json"), original);
  const logs = [];
  const box = new Outbox({
    log: (m) => logs.push(m),
    deliver: never,
    settled: () => {},
  });
  check(box.pending().length === 0, "截断的 outbox 读成空队列（而不是崩溃）");
  const bak = backupOf("outbox.json");
  check(fs.readFileSync(bak, "utf8") === original, "备份保留原始字节（半行也照留）", path.basename(bak));
  check(logs.some((m) => m.includes("已备份到")), "日志说清了备份位置", logs.join(" | "));

  box.add({ id: "m3", peerId: "P", addr: "10.0.0.1", port: 1, kind: "text", payload: { text: "三" }, at: Date.now(), tries: 0, nextAt: 0 });
  const now = JSON.parse(fs.readFileSync(stateFile("outbox.json"), "utf8"));
  check(now.length === 1 && now[0].id === "m3", "新消息只写自己，不拿空队列覆盖", JSON.stringify(now));
  check(fs.existsSync(bak), "写入之后备份仍在");
  box.stop();
}

// ---------------------------------------------------------------- 3. peers
{
  fs.writeFileSync(stateFile("outbox.json"), "[]");
  const original = `{"n1":{"friend":true},"n2":{"friend":true}`;
  fs.writeFileSync(stateFile("peers.json"), original);
  const rel = new Relations(() => {});
  rel.quickAdd({ nodeId: "n9", nickname: "new" });
  check(fs.readFileSync(backupOf("peers.json"), "utf8") === original, "peers 截断后留档原字节");
  const now = JSON.parse(fs.readFileSync(stateFile("peers.json"), "utf8"));
  check(Object.keys(now).join(",") === "n9", "好友表只剩新加的那个（旧数据没被当成空表写没？它在备份里）", Object.keys(now).join(","));
}

// ---------------------------------------------------------------- 4. threads
{
  fs.writeFileSync(stateFile("peers.json"), "{}");
  const original = `{"n1":{"pinned":true},"n2":{"draft":"半句`;
  fs.writeFileSync(stateFile("threads.json"), original);
  const th = new Threads(() => {});
  th.patch("n9", { pinned: true });
  check(fs.readFileSync(backupOf("threads.json"), "utf8") === original, "threads 截断后留档原字节");
  const now = JSON.parse(fs.readFileSync(stateFile("threads.json"), "utf8"));
  check(Object.keys(now).join(",") === "n9", "会话元数据只剩新 patch 的那个", Object.keys(now).join(","));
}

// ---------------------------------------------------------------- 5. 正常路径
{
  fs.writeFileSync(stateFile("threads.json"), JSON.stringify({ n1: { pinned: true } }));
  const th = new Threads(() => {});
  check(th.get("n1").pinned === true, "合法文件照常读入");
}

fs.rmSync(ROOT, { recursive: true, force: true });
log(failed ? "FAILED" : "OK");
process.exit(failed ? 1 : 0);
