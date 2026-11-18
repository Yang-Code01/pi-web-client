/**
 * 实时那条 assistant 消息要带 ts（页面抬头写的「模型名 · 时间」）。
 *
 * 以前只有重放的历史条目有 `ts`（`items.ts` 用 pi 自己的 `entry.timestamp`），实时流式那条
 * 在 `message_start` / `message_end` 两个分支里都没有 —— 于是页面上模型回复的抬头只剩一个
 * 悬空的「pi · 」，而用户消息有「你 · 15:32」。
 *
 * 这里锁三件事：
 *   1. `message_start` 发出去的那张草稿卡就有 ts；
 *   2. `message_end` 换成 `live:` 那条时**沿用同一个 ts**——不随说话时长往后漂，刷新后跟重放对得上；
 *   3. 下一条消息重新打点，不会继承上一条的时间。
 *
 * 不启真 pi、不开浏览器：直接喂 `onPiEvent`。
 *
 * Run: node --experimental-strip-types bridge/tests/message-time-unit.mjs
 * （也可 `npm run test:msgtime`；`--experimental-transform-types` 在 Node 26 上已经不存在了）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "pi-msgts-"));
process.env.PI_WEB_STATE = STATE;

const { Session } = await import("../src/sessions.ts");

const meta = (id) => ({
  file: path.join(STATE, `${id}.jsonl`),
  id,
  cwd: process.cwd(),
  startedAt: new Date().toISOString(),
  name: null,
  nameAt: null,
  firstUserText: null,
  mtime: Date.now(),
});

/** 开一个只收 ws 帧的会话：不 spawn pi，`emitWs` 直接进数组。 */
function harness(id) {
  fs.writeFileSync(path.join(STATE, `${id}.jsonl`), `${JSON.stringify({ type: "session", id })}\n`);
  const s = new Session(process.execPath, meta(id));
  const frames = [];
  s.on("ws", (frame) => frames.push(frame));
  const feed = (ev) => s.onPiEvent(ev);
  return { s, frames, feed };
}

const start = (model = "claude-test") => ({ type: "message_start", message: { role: "assistant", model } });
const end = (text, model = "claude-test") => ({
  type: "message_end",
  message: { role: "assistant", model, stopReason: "endTurn", content: [{ type: "text", text }] },
});

/** 一轮：开口 → 吐字 → 收尾；返回两条帧上的 item。 */
function turn(feed, frames, text, model) {
  const from = frames.length;
  feed(start(model));
  feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  feed(end(text, model));
  const added = frames.slice(from).find((f) => f.type === "item.add" && f.item?.kind === "assistant");
  const replaced = frames.slice(from).find((f) => f.type === "item.replace");
  return { added: added?.item, replaced: replaced?.item, draftId: replaced?.id };
}

const iso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));
let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${err?.message ?? err}`);
  }
};

const a = harness("aaaa1111");
const first = turn(a.feed, a.frames, "第一句");

check("message_start 的草稿卡就带 ts", () => {
  assert.ok(first.added, "没有拿到 item.add");
  assert.ok(iso(first.added.ts), `草稿卡的 ts 不是时间：${String(first.added.ts)}`);
});

check("model 还在（抬头前半截照旧）", () => {
  assert.equal(first.added.model, "claude-test");
});

check("message_end 沿用开口那一下的 ts（不往后漂）", () => {
  assert.ok(first.replaced, "没有拿到 item.replace");
  assert.equal(first.replaced.ts, first.added.ts);
});

check("存进 items 的那条也带同一个 ts（刷新后重放用的是它）", () => {
  const stored = a.s.items.find((it) => it.kind === "assistant");
  assert.ok(stored, "items 里没有 assistant");
  assert.equal(stored.ts, first.added.ts);
});

check("换 id：草稿 `draft:N` 换成 `live:N`", () => {
  assert.match(first.draftId, /^draft:\d+$/);
  assert.match(first.replaced.id, /^live:\d+$/);
});

const second = turn(a.feed, a.frames, "第二句");

check("下一条消息重新打点，不继承上一条的时间", () => {
  const gap = Date.parse(second.replaced.ts) - Date.parse(first.replaced.ts);
  assert.ok(gap >= 0, `第二条比第一条还早：${second.replaced.ts}`);
  assert.notEqual(second.added.id, first.added.id, "草稿 id 必须换一个");
});

check("没有 message_start 的孤立 message_end 也补一个 ts", () => {
  const b = harness("bbbb2222");
  b.feed(end("没有开口事件"));
  const live = b.frames.find((f) => f.type === "item.add" && f.item?.kind === "assistant");
  assert.ok(live, "没有拿到 item.add");
  assert.ok(iso(live.item.ts), `ts 不是时间：${String(live.item.ts)}`);
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
