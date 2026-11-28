/**
 * 自动评审的页面那半（D457）：阶段条怎么切、一行话怎么拼、回执怎么对上意见。
 *
 * 这层不重画 DOM，只钉几个纯函数 —— 它们决定「卡片上那句话是不是真的」：
 * 判错了会把「跳过」写成「签收」、把「还没评」写成「进行中」。
 *
 *   node --experimental-strip-types web/tests/reviewauto-unit.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { fmtTok, roundLine, roundResult, roundStatusLabel, stageChips, stageClass, statePill, verdictOf, verdictLabel, waitText, worstSeverity, footerText, noteText } =
  await import("../src/reviewauto.ts");

const round = (n, over = {}) => ({
  n,
  slot: n % 2 === 1 ? "A" : "B",
  label: `m${n}`,
  model: "m",
  provider: "p",
  runId: `r${n}`,
  status: "clean",
  sha: "aaaaaaa",
  findings: 0,
  severity: {},
  note: "",
  ...over,
});

const state = (over = {}) => ({
  session: "s",
  status: "running",
  wait: "",
  cur: 1,
  rounds: [],
  reason: "",
  reasonCode: "",
  tokens: 0,
  summary: "",
  startedAt: new Date().toISOString(),
  endedAt: "",
  config: { mode: "pr", pr: 747, branch: "feat/x", maxRounds: 10, autoMerge: false, models: { a: { provider: "p", model: "a", label: "A" }, b: { provider: "p", model: "b", label: "B" } }, repo: "/r" },
  merge: { pr: 747, state: "waiting", note: "" },
  ...over,
});

test("token 数字", () => {
  assert.equal(fmtTok(0), "0 tok");
  assert.equal(fmtTok(940), "940 tok");
  assert.equal(fmtTok(31400), "31.4k tok");
  assert.equal(fmtTok(2_500_000), "2.5M tok");
});

test("阶段条：最多 6 格，取最近的几轮", () => {
  const rounds = Array.from({ length: 9 }, (_, i) => round(i + 1));
  const chips = stageChips(state({ rounds, cur: 9 }));
  assert.equal(chips.length, 6);
  assert.equal(chips[0].n, 4);
  assert.equal(chips.at(-1).n, 9);
});

test("阶段条：不超过 6 轮时全给出来，且按轮号升序（乱序进来也一样）", () => {
  // 与上一条（> 6 轮只留最近 6 格）钉的是两件事：这里验「不截断 + 排序」，
  // 而且 `stageChips` 只看 rounds —— status 不参与，用 signed 只是顺手。
  const rounds = [round(3), round(1), round(2)];
  assert.deepEqual(stageChips(state({ rounds, status: "signed" })).map((r) => r.n), [1, 2, 3]);
});

test("状态词：跳过 ≠ 签收", () => {
  assert.equal(roundStatusLabel({ status: "skipped" }), "已跳过");
  assert.equal(roundStatusLabel({ status: "clean" }), "零意见");
  assert.notEqual(roundStatusLabel({ status: "skipped" }), roundStatusLabel({ status: "clean" }));
});

test("轮次上的说明：桥只给码，这里翻成人话；认不出来的原样给", () => {
  assert.equal(noteText("skipped"), "你跳过了这一轮");
  assert.equal(noteText("stale"), "桥重启了，这一轮没跑完");
  assert.equal(noteText(""), "");
  assert.equal(noteText("模型写的一句理由"), "模型写的一句理由");
});

test("一轮的标题行：四种状态各说各的", () => {
  assert.match(roundLine(round(1, { status: "clean" })), /签收/);
  assert.match(roundLine(round(1, { status: "clean", note: "dismissed" })), /误报/);
  assert.match(roundLine(round(2, { status: "skipped" })), /跳过/);
  assert.match(roundLine(round(2, { status: "failed" })), /失败/);
  assert.match(roundLine(round(2, { status: "findings", findings: 3, fix: { files: 2, added: 5, removed: 1 } })), /3 条意见.*2 个文件/s);
});

test("抬头那枚状态：跑着给轮次、签收给结论", () => {
  assert.equal(statePill(state({ status: "running", cur: 3 })).text, "第 3 / 10 轮");
  assert.equal(statePill(state({ status: "signed" })).text, "两家已签收");
  assert.equal(statePill(state({ status: "merged" })).tone, "ok");
  assert.equal(statePill(state({ status: "paused", cur: 4 })).tone, "warn");
  assert.equal(statePill(state({ status: "stopped" })).text, "已停止");
});

test("正在干什么：合并在跑时说的是合并", () => {
  assert.match(waitText(state({ wait: "merge", status: "running" })), /合并 PR #747/);
  assert.match(waitText(state({ wait: "fix", status: "running" })), /修完/);
  assert.equal(waitText(state({ status: "signed" })), "");
});

test("最严重的意见：按 严重→高→中→低 挑", () => {
  assert.equal(worstSeverity({ severity: { low: 2, high: 1 } }), "high");
  assert.equal(worstSeverity({ severity: {} }), "");
});

test("回执对得上意见：先按 path+行，再退回只按 path", () => {
  const r = round(1, {
    verdicts: [
      { path: "a.ts", line: 9, verdict: "fixed", why: "改了" },
      { path: "b.ts", line: 0, verdict: "false-positive", why: "不成立" },
    ],
  });
  assert.equal(verdictOf(r, { path: "a.ts", startLine: 9 })?.verdict, "fixed");
  assert.equal(verdictOf(r, { path: "b.ts", startLine: 4 })?.verdict, "false-positive");
  assert.equal(verdictOf(r, { path: "c.ts", startLine: 1 }), null);
  assert.equal(verdictOf(null, { path: "a.ts", startLine: 9 }), null);
});

test("三种判定各有说法", () => {
  assert.equal(verdictLabel("fixed"), "已修");
  assert.equal(verdictLabel("false-positive"), "误报");
  assert.equal(verdictLabel("wontfix"), "不改");
  assert.equal(verdictLabel(""), "");
});

test("阶段条那一格：跑完 / 跑着 / 跳过 / 失败各一种样式", () => {
  const st = { cur: 2 };
  assert.equal(stageClass(round(1, { status: "findings" }), st), "done", "跑完且有意见的那一轮已经填满");
  assert.equal(stageClass(round(2, { status: "running" }), st), "now");
  assert.equal(stageClass(round(3, { status: "findings" }), { cur: 2 }), "done");
  assert.equal(stageClass(round(4, { status: "clean" }), st), "ok");
  assert.equal(stageClass(round(5, { status: "skipped" }), st), "skip");
  assert.equal(stageClass(round(6, { status: "failed" }), st), "bad");
});

test("一轮的结论不含抬头：明细行与 title 各拼一次", () => {
  assert.equal(roundResult(round(3, { status: "findings", findings: 2, fix: { files: 1, added: 3, removed: 1 } })), "2 条意见 → 已修 1 个文件");
  assert.ok(!roundResult(round(3, { status: "clean" })).includes("#3"), "结论里不带 #n A 抬头");
  assert.equal(roundLine(round(3, { status: "clean" })), "#3 A · 零意见 · 签收");
});

test("底行：轮数 + token + 用时", () => {
  const started = new Date(Date.now() - 7 * 60_000).toISOString();
  const text = footerText({ rounds: [round(1), round(2)], tokens: 12000, startedAt: started, endedAt: "", status: "running" });
  assert.match(text, /2 轮/);
  assert.match(text, /12\.0k tok/);
  assert.match(text, /分钟/);
});

test("底行：已经停下但缺 endedAt 的记录，用时不再一直往上涨", () => {
  const started = new Date(Date.now() - 7 * 60_000).toISOString();
  const base = { rounds: [round(1)], tokens: 100, startedAt: started, endedAt: "" };
  const stopped = footerText({ ...base, status: "stopped" });
  assert.doesNotMatch(stopped, /分钟/, "拿不到结束时刻就不报用时（否则每次重绘都在涨）");
  // 有 endedAt 就照实报
  const withEnd = footerText({ ...base, status: "stopped", endedAt: new Date(Date.parse(started) + 3 * 60_000).toISOString() });
  assert.match(withEnd, /3 分钟/);
  // 还在跑 / 暂停中：用「现在」
  assert.match(footerText({ ...base, status: "paused" }), /分钟/);
});
