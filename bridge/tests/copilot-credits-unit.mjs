/**
 * Copilot 积分（#copilot-credits）：只验不需要网络、不需要真 pi 的那几段。
 *
 * 这里守的是会悄悄漂的东西：
 *  - 增量读会话 JSONL：半行必须留到下次、文件变短必须重来、文件不在不能崩；
 *  - provider 分账：copilot 的积分与非 copilot 的美元不能混成一个数；
 *  - 对账：只有本机偏多才算异常，样本太小（<10 积分）与月度重置都不提示；
 *  - 换算口径：`usage.cost × 100` 与真值条目谁优先；
 *  - 账号额度：真实 Business 响应能被解析，`quota_reset_at: 0` 不能盖掉账号级重置时间。
 *
 *   node --experimental-transform-types bridge/tests/copilot-credits-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const M = await import("../src/copilot-credits.ts");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "copilot-credits-"));

const creditLine = (credits, at = "2026-11-18T00:00:00.000Z") =>
  JSON.stringify({ type: "custom", customType: M.COPILOT_CREDIT_ENTRY, data: { credits, at } }) + "\n";

const accountLine = (data) =>
  JSON.stringify({ type: "custom", customType: M.COPILOT_ACCOUNT_ENTRY, data }) + "\n";

const assistant = (provider, usd) =>
  JSON.stringify({ type: "message", message: { role: "assistant", provider, usage: { cost: { total: usd } } } }) + "\n";

test("增量读：整行入账，半行留到下一次补上", () => {
  const dir = tmp();
  const file = path.join(dir, "session.jsonl");
  const first = creditLine(0.5) + creditLine(0.25);
  fs.writeFileSync(file, first);
  const tally = new M.CopilotTally();
  let view = tally.read(file);
  assert.equal(view.hasCopilot, true);
  assert.equal(view.credits, 0.75);
  assert.equal(view.requests, 2);

  // 追加一整条 + 一条只写了一半的
  fs.appendFileSync(file, creditLine(1));
  const tail = creditLine(2);
  fs.appendFileSync(file, tail.slice(0, 10));
  view = tally.read(file);
  assert.equal(view.credits, 1.75, "半行不算");
  assert.equal(view.requests, 3);

  // 半行写完
  fs.appendFileSync(file, tail.slice(10));
  view = tally.read(file);
  assert.equal(view.credits, 3.75);
  assert.equal(view.requests, 4);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("增量读：文件变短（换会话/被重写）从头再来；文件不在返回上次结果", () => {
  const dir = tmp();
  const file = path.join(dir, "session.jsonl");
  // 100 比 1 多两个字符：新内容确实更短，才逼出「截断要重来」这条路径
  fs.writeFileSync(file, creditLine(100));
  const tally = new M.CopilotTally();
  assert.equal(tally.read(file).credits, 100);

  fs.writeFileSync(file, creditLine(1));
  assert.equal(tally.read(file).credits, 1, "变短要 reset，不能叠加旧值");

  fs.rmSync(file);
  assert.equal(tally.read(file).credits, 1, "文件不在就沿用上次结果");

  assert.equal(new M.CopilotTally().read(path.join(dir, "nope.jsonl")).hasCopilot, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("坏行跳过，不影响后面的记账", () => {
  const dir = tmp();
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, "not json\n" + creditLine(0.1));
  assert.equal(new M.CopilotTally().read(file).credits, 0.1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("provider 分账：copilot 记积分，别的 provider 记美元，两者互不污染", () => {
  const entries = [
    { type: "message", message: { role: "assistant", provider: "github-copilot", usage: { cost: { total: 0.02 } } } },
    { type: "custom", customType: M.COPILOT_CREDIT_ENTRY, data: { credits: 2, at: "2026-11-18T00:00:00.000Z" } },
    { type: "message", message: { role: "assistant", provider: "anthropic", usage: { cost: { total: 0.4 } } } },
    { type: "message", message: { role: "user" } },
  ];
  const view = M.copilotFromEntries(entries);
  assert.equal(view.hasCopilot, true);
  assert.equal(view.credits, 2);
  assert.equal(view.otherCost, 0.4);
  assert.equal(view.requests, 2, "带价格的 copilot 消息也记一笔（这条是 0.02 美元 = 2 积分）");
  assert.equal(view.lastAt, "2026-11-18T00:00:00.000Z");
});

test("只有带 github-copilot 的 message 也算 copilot 会话（老会话没记账条目）", () => {
  const view = M.copilotFromEntries([
    { type: "message", message: { role: "assistant", provider: "github-copilot", usage: { cost: { total: 0.01 } } } },
  ]);
  assert.equal(view.hasCopilot, true);
  assert.equal(view.credits, 1, "0.01 美元 × 100 = 1 积分");
  assert.equal(view.estimated, true, "没有真值条目就是换算值");
  assert.equal(view.otherCost, 0, "copilot 自己的美元不进 otherCost");
});

test("nanoAiu 兜底：条目只带 nanoAiu 时按 1e9 折积分", () => {
  const view = M.copilotFromEntries([
    { type: "custom", customType: M.COPILOT_CREDIT_ENTRY, data: { nanoAiu: 1_300_000, at: "2026-11-18T00:00:00.000Z" } },
  ]);
  assert.equal(view.credits, 0.0013);
});

test("对账：本机偏多才算异常，样本太小不提示，重置清掉", () => {
  const dir = tmp();
  const file = path.join(dir, "session.jsonl");
  const tally = new M.CopilotTally();

  fs.writeFileSync(file, accountLine({ used: 1000, remaining: 9000, at: "2026-11-18T00:00:00.000Z" }));
  assert.equal(tally.read(file).reconcile, null, "第一份快照没有可比基线");

  // 本机记了 20 积分，账号只涨 10 → 偏差 100%
  fs.appendFileSync(file, creditLine(20, "2026-11-18T00:01:00.000Z"));
  fs.appendFileSync(file, accountLine({ used: 1010, remaining: 8990, at: "2026-11-18T00:02:00.000Z" }));
  const view = tally.read(file);
  assert.equal(view.reconcile?.accountDelta, 10, "账号增量不足 10 积分只记基线、不提示");
  assert.equal(view.reconcile?.localDelta, 20);
  assert.equal(Math.round(view.reconcile?.gapPercent), 100);

  // 样本太小（<10 积分）不提示
  fs.appendFileSync(file, creditLine(1, "2026-11-18T00:03:00.000Z"));
  fs.appendFileSync(file, accountLine({ used: 1011, remaining: 8989, at: "2026-11-18T00:04:00.000Z" }));
  assert.equal(tally.read(file).reconcile, null);

  // 月度重置（used 变小）清掉对账
  fs.appendFileSync(file, accountLine({ used: 0, remaining: 10000, at: "2026-12-01T00:00:00.000Z" }));
  assert.equal(tally.read(file).reconcile, null);
  assert.equal(tally.read(file).account?.used, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("额度快照：缺字段留 null，不猜 0；unlimited / overage 原样带过来", () => {
  const view = M.copilotFromEntries([
    {
      type: "custom",
      customType: M.COPILOT_ACCOUNT_ENTRY,
      data: {
        entitlement: 500000,
        used: 30020,
        remaining: 469980.4,
        percentRemaining: 93.9,
        resetUtc: "2026-12-01T00:00:00.000Z",
        plan: "business",
        sku: "copilot_for_business_seat_quota",
        unlimited: false,
        overagePermitted: true,
        at: "2026-11-18T00:00:00.000Z",
      },
    },
  ]);
  assert.equal(view.account?.entitlement, 500000);
  assert.equal(view.account?.percentRemaining, 93.9);
  assert.equal(view.account?.plan, "business");
  assert.equal(view.account?.unlimited, false);
  assert.equal(view.account?.overagePermitted, true);

  const bare = M.copilotFromEntries([
    { type: "custom", customType: M.COPILOT_ACCOUNT_ENTRY, data: { used: 3, remaining: 7, at: "x" } },
  ]);
  assert.equal(bare.account?.entitlement, null);
  assert.equal(bare.account?.resetUtc, null);
  assert.equal(bare.account?.used, 3);

  const empty = M.copilotFromEntries([
    { type: "custom", customType: M.COPILOT_ACCOUNT_ENTRY, data: { at: "x" } },
  ]);
  assert.equal(empty.account, null, "两个数字都没有就当没有快照");
});

test("换算：copilot 请求按 cost×100 入账，标成估算；别的 provider 记美元", () => {
  const view = M.copilotFromEntries([
    { type: "message", message: { role: "assistant", provider: "github-copilot", usage: { cost: { total: 0.0080125 } }, timestamp: "2026-11-18T05:47:22.732Z" } },
    { type: "message", message: { role: "assistant", provider: "github-copilot", usage: { cost: { total: 0.13588 } } } },
    { type: "message", message: { role: "assistant", provider: "wb2api", usage: { cost: { total: 0.42 } } } },
  ]);
  assert.equal(view.hasCopilot, true);
  assert.equal(view.estimated, true);
  assert.equal(view.requests, 2);
  assert.equal(Number(view.credits.toFixed(6)), 14.38925, "0.80125 + 13.588");
  assert.equal(view.otherCost, 0.42, "别的 provider 单独记");
  assert.equal(view.lastAt, "2026-11-18T05:47:22.732Z");
});

test("换算：会话里有真值条目就整段用真值，不再乘 100", () => {
  const view = M.copilotFromEntries([
    { type: "message", message: { role: "assistant", provider: "github-copilot", usage: { cost: { total: 0.01 } } } },
    { type: "custom", customType: M.COPILOT_CREDIT_ENTRY, data: { credits: 1.43825, at: "2026-11-18T05:47:22.732Z" } },
  ]);
  assert.equal(view.estimated, false);
  assert.equal(view.credits, 1.43825, "有真值时不叠加 cost 换算");
  assert.equal(view.requests, 2);
});

test("账号额度：按真实 Business 响应解析（含 token 计费与重置时间）", () => {
  const body = {
    sku: "copilot_for_business_seat_quota",
    copilot_plan: "business",
    quota_reset_date: "2026-12-01",
    quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
    quota_snapshots: {
      premium_interactions: {
        entitlement: 500000,
        remaining: 469980.4,
        credits_used: 30020,
        percent_remaining: 93.9,
        unlimited: false,
        overage_permitted: true,
        token_based_billing: true,
        quota_reset_at: 0,
      },
      chat: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true },
    },
  };
  const account = M.accountFrom(body, "2026-11-18T13:00:00.000Z");
  assert.equal(account?.entitlement, 500000);
  assert.equal(account?.used, 30020);
  assert.equal(account?.remaining, 469980.4);
  assert.equal(account?.percentRemaining, 93.9);
  assert.equal(account?.resetUtc, "2026-12-01T00:00:00.000Z", "优先 UTC 字段，quota_reset_at:0 不能盖掉它");
  assert.equal(account?.plan, "business");
  assert.equal(account?.unlimited, false);
  assert.equal(account?.overagePermitted, true);
  assert.equal(account?.at, "2026-11-18T13:00:00.000Z");

  const stamped = M.accountFrom({ quota_snapshots: { premium_interactions: { used: 1, remaining: 2, quota_reset_at: 1764547200 } } });
  assert.equal(stamped?.resetUtc, new Date(1764547200 * 1000).toISOString());
  assert.equal(stamped?.plan, null);

  assert.equal(M.accountFrom({}), null);
  assert.equal(M.accountFrom(null), null);
  assert.equal(M.accountFrom({ quota_snapshots: { premium_interactions: { unlimited: true } } }), null, "没有数字就没有快照");
});

test("账号额度：拉不到（没凭据 / 非 200 / 抛错）一律 null，不抛", async () => {
  const saved = process.env.COPILOT_GITHUB_TOKEN;
  delete process.env.COPILOT_GITHUB_TOKEN;
  const savedAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmp(); // 空目录 = 没有 auth.json
  try {
    assert.equal(await M.fetchCopilotAccount(async () => assert.fail("没凭据时不该发请求")), null);

    process.env.COPILOT_GITHUB_TOKEN = "gho_test";
    assert.equal(await M.fetchCopilotAccount(async () => ({ ok: false, json: async () => ({}) })), null);
    assert.equal(
      await M.fetchCopilotAccount(async () => ({ ok: true, json: async () => ({ quota_snapshots: { premium_interactions: { used: 5, remaining: 5 } } }) })).then((a) => a?.used),
      5,
    );
    assert.equal(
      await M.fetchCopilotAccount(async () => {
        throw new Error("boom");
      }),
      null,
    );
  } finally {
    if (saved === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
    else process.env.COPILOT_GITHUB_TOKEN = saved;
    if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgent;
  }
});

test("D339：长任务进行中，第一条 assistant message_end 后即推送 copilot 帧并更新 snapshot", async () => {
  const dir = tmp();
  const savedState = process.env.PI_WEB_STATE;
  const savedToken = process.env.COPILOT_GITHUB_TOKEN;
  const savedAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_WEB_STATE = dir;
  delete process.env.COPILOT_GITHUB_TOKEN;
  process.env.PI_CODING_AGENT_DIR = dir; // 空目录：不发真实 GitHub 请求
  try {
    const { Session } = await import("../src/sessions.ts");
    const id = "cop-mid-turn";
    const file = path.join(dir, `${id}.jsonl`);
    // 新会话开局：只有头和 user 消息，还没有 assistant 消息
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: "session", id })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "hi" } })}\n`,
    );
    const s = new Session(process.execPath, {
      file,
      id,
      cwd: process.cwd(),
      startedAt: new Date().toISOString(),
      name: null,
      nameAt: null,
      firstUserText: "hi",
      mtime: Date.now(),
    });
    const frames = [];
    s.on("ws", (f) => frames.push(f));

    await s.refreshCopilot();
    assert.equal(s.snapshot().copilot?.hasCopilot, false, "尚无 assistant 消息时 hasCopilot 为 false");

    // 模拟第一轮长任务中途：第一条 assistant（调用工具）已写入 JSONL，但未到 agent_end
    fs.appendFileSync(file, assistant("github-copilot", 0.12));
    s.onPiEvent({
      type: "message_end",
      message: { role: "assistant", model: "claude-opus-4.5", stopReason: "toolUse", content: [{ type: "text", text: "step 1" }] },
    });
    await new Promise((r) => setTimeout(r, 10));

    const copilotFrames = frames.filter((f) => f.type === "copilot");
    const latest = copilotFrames.at(-1);
    assert.equal(latest?.hasCopilot, true, "第一条 message_end 后立刻推 hasCopilot=true");
    assert.ok(Math.abs((latest?.credits ?? 0) - 12) < 1e-6, "第一笔 0.12 美元 = 12 积分");
    assert.equal(s.snapshot().copilot?.hasCopilot, true, "snapshot() 同步带出最新积分视图");

    // 同一轮里第二条 assistant 落盘，积分应随之递增
    fs.appendFileSync(file, assistant("github-copilot", 0.08));
    s.onPiEvent({
      type: "message_end",
      message: { role: "assistant", model: "claude-opus-4.5", stopReason: "toolUse", content: [{ type: "text", text: "step 2" }] },
    });
    await new Promise((r) => setTimeout(r, 10));

    const afterSecond = frames.filter((f) => f.type === "copilot").at(-1);
    assert.ok(Math.abs((afterSecond?.credits ?? 0) - 20) < 1e-6, "第二笔追加后累计 20 积分");
    assert.equal(afterSecond?.requests, 2);
  } finally {
    if (savedState === undefined) delete process.env.PI_WEB_STATE;
    else process.env.PI_WEB_STATE = savedState;
    if (savedToken === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
    else process.env.COPILOT_GITHUB_TOKEN = savedToken;
    if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgent;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
