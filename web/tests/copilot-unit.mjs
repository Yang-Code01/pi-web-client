/**
 * Copilot 积分格式化（web/src/copilot.ts）：只验纯函数，不碰 DOM。
 *
 * 守的是决策里那几条「看起来琐碎、但一漂就会被人看到」的规则：
 *  - 精度分档 <1 三位 / <100 两位 / ≥100 整数；
 *  - 账号行永远并列 UTC 与本地时间；
 *  - 混合会话才分账；
 *  - 估算兜底按 1 积分 = $0.01。
 *
 *   node --experimental-strip-types web/tests/copilot-unit.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const M = await import("../src/copilot.ts");

test("积分精度：三档，整数档才带千分位", () => {
  assert.equal(M.formatCredits(0.0013), "0.001");
  assert.equal(M.formatCredits(0.02), "0.020");
  assert.equal(M.formatCredits(0.5), "0.500");
  assert.equal(M.formatCredits(1), "1.00");
  assert.equal(M.formatCredits(12.345), "12.35");
  assert.equal(M.formatCredits(99.999), "100.00", "四舍五入跨档就按两位写，不回头改");
  assert.equal(M.formatCredits(100), "100");
  assert.equal(M.formatCredits(1234.6), "1,235");
  assert.equal(M.formatCredits(469980.4), "469,980");
  assert.equal(M.formatCredits(null), "–");
  assert.equal(M.formatCredits(undefined), "–");
  assert.equal(M.formatCredits(Number.NaN), "–");
});

test("积分折美元：小额多给两位小数，别写成 $0.00", () => {
  assert.equal(M.creditsToUsd(0.5), "$0.0050");
  assert.equal(M.creditsToUsd(1), "$0.010");
  assert.equal(M.creditsToUsd(50), "$0.500");
  assert.equal(M.creditsToUsd(300), "$3.00");
  assert.equal(M.creditsToUsd(null), null);
});

test("美元折积分：1 积分 = $0.01，估算是 cost × 100", () => {
  assert.equal(M.usdToCredits(0.0080125), 0.80125);
  assert.equal(M.usdToCredits(0), 0);
  assert.equal(M.usdToCredits(null), null);
});

test("重置时间：UTC 与本地并列，天数是向上取整且不为负", () => {
  const now = Date.parse("2026-11-18T00:00:00.000Z");
  const r = M.formatReset("2026-12-01T00:00:00.000Z", now);
  assert.equal(r?.utc, "2026-12-01 00:00 UTC");
  assert.equal(r?.daysLeft, 13);
  assert.ok(r?.local, "本地那一份必须有");
  assert.equal(M.formatReset(null, now), null);
  assert.equal(M.formatReset("not-a-date", now), null);

  const past = M.formatReset("2026-11-01T00:00:00.000Z", now);
  assert.equal(past?.daysLeft, 0, "已经过期的重置时间不显示负数");
});

test("混合会话：只有 copilot 且有其它 provider 的花费才算", () => {
  const pure = { ...M.EMPTY_COPILOT, hasCopilot: true, credits: 12, otherCost: 0 };
  assert.equal(M.isMixed(pure), false);
  assert.equal(M.isMixed({ ...pure, otherCost: 0.4 }), true);
  assert.equal(M.isMixed({ ...pure, hasCopilot: false, otherCost: 0.4 }), false, "没走过 copilot 就不该出现专项块");
  assert.equal(M.isMixed(null), false);
});

test("额度用量：unlimited / 缺字段都不画进度条", () => {
  const account = {
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
  };
  assert.equal(Math.round(M.usedPercent(account)), 6);
  assert.equal(M.usedPercent({ ...account, unlimited: true }), null);
  assert.equal(M.usedPercent({ ...account, entitlement: 0 }), null);
  assert.equal(M.usedPercent({ ...account, used: null }), null);
  assert.equal(M.usedPercent(null), null);
});

test("刷新年龄：45 秒内算 just now，之后按分钟、小时", () => {
  const now = Date.parse("2026-11-18T01:00:00.000Z");
  assert.equal(M.formatAge("2026-11-18T00:59:30.000Z", now), "just now");
  assert.equal(M.formatAge("2026-11-18T00:58:00.000Z", now), "2m");
  assert.equal(M.formatAge("2026-11-17T23:00:00.000Z", now), "2h");
  assert.equal(M.formatAge(null, now), null);
  assert.equal(M.formatAge("2026-11-18T02:00:00.000Z", now), "just now", "时钟偏了也别写负数");
});
