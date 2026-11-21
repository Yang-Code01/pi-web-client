/**
 * Unit: `bridge/src/whatsnew.ts` —— 「启动时自动打开本项目更新履历」的判定（#588）。
 *
 * 只测纯的那一半：给定 CHANGELOG 原文 + 已读状态 + 当前时刻，算出「该不该弹、弹哪一批、还有几批
 * 更早的」。不启桥、不碰文件、不碰 HTTP —— 文件读写与路由接线在 `bridge/src/index.ts` 里，
 * 由 `probes/whatsnew-dialog.mjs` 走真流程验。
 *
 *   node --test bridge/tests/whatsnew-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { WHATSNEW_THROTTLE_MS, whatsnewBatches, whatsnewDecision } from "../src/whatsnew.ts";

/** 手工写的三段日志：顶部有锚点注释与大标题，批次之间夹着 `###` 分组与列表项。 */
const LOG = `# pi-web-client 更新日志

<!-- 写到 103a01a · 2026-11-20 -->
<!-- 下一批从这里往后读：git log --first-parent 103a01a..origin/main -->

## 未发布 · 外观只剩 Mac 风格

### 设计决定

- 删掉「配色主题」那七套 #583 D353
- 已经选过配色主题的人不会被扔回白底 #583 D353

## 2026-11-20 · 十套配色，内网通开群

### 新增

- 配色主题再添三套 #559 D337

### 修复

- 执行面板的 Copilot 积分块 #564

## 2026-11-19 · 四套配色

### 新增

- 设置控制台照「本机管理」重排 #551
`;

const EMPTY = { seenTitle: "", lastShownAt: 0 };
const NOW = Date.parse("2026-11-21T12:00:00Z");
const LONG_AGO = NOW - WHATSNEW_THROTTLE_MS - 1;

test("批次按 `## ` 切，注释与大标题不进批次", () => {
  const batches = whatsnewBatches(LOG);
  assert.deepEqual(
    batches.map((b) => b.title),
    ["未发布 · 外观只剩 Mac 风格", "2026-11-20 · 十套配色，内网通开群", "2026-11-19 · 四套配色"],
  );
  // 正文是这一批自己的内容，不越过下一个 `## `
  assert.match(batches[0].body, /删掉「配色主题」那七套/);
  assert.doesNotMatch(batches[0].body, /配色主题再添三套/);
  assert.match(batches[1].body, /配色主题再添三套/);
  // `<!-- -->` 本来就会被 selfChangelog 抹掉；万一漏进来也不能当成正文
  assert.doesNotMatch(batches[0].body, /写到 103a01a/);
});

test("没有日志 / 没有批次时不弹", () => {
  assert.equal(whatsnewDecision({ text: "", state: EMPTY, now: NOW }).status, "none");
  assert.equal(whatsnewDecision({ text: "# 只有大标题\n\n没有批次", state: EMPTY, now: NOW }).status, "none");
});

test("从没看过：弹最新一批，更早的都算「还有 N 批」", () => {
  const d = whatsnewDecision({ text: LOG, state: EMPTY, now: NOW });
  assert.equal(d.status, "ok");
  if (d.status !== "ok") return;
  assert.equal(d.batch.title, "未发布 · 外观只剩 Mac 风格");
  assert.equal(d.olderCount, 2);
  // 「还有 N 批」展开后看到的就是这两批，顺序与文件一致（新的在前）
  assert.deepEqual(
    d.older.map((b) => b.title),
    ["2026-11-20 · 十套配色，内网通开群", "2026-11-19 · 四套配色"],
  );
});

test("已读就是最新那批：没有新的，不弹", () => {
  const state = { seenTitle: "未发布 · 外观只剩 Mac 风格", lastShownAt: LONG_AGO };
  assert.equal(whatsnewDecision({ text: LOG, state, now: NOW }).status, "no-new");
});

test("已读停在中间：弹最新一批，中间的几批算「还有 N 批」", () => {
  const state = { seenTitle: "2026-11-19 · 四套配色", lastShownAt: LONG_AGO };
  const d = whatsnewDecision({ text: LOG, state, now: NOW });
  assert.equal(d.status, "ok");
  if (d.status !== "ok") return;
  assert.equal(d.batch.title, "未发布 · 外观只剩 Mac 风格");
  assert.equal(d.olderCount, 1);
  assert.deepEqual(d.older.map((b) => b.title), ["2026-11-20 · 十套配色，内网通开群"]);
});

test("已读的那批被改写/删掉了：当作没记录，仍然弹", () => {
  const state = { seenTitle: "2026-11-18 · 早被重写的那批", lastShownAt: LONG_AGO };
  const d = whatsnewDecision({ text: LOG, state, now: NOW });
  assert.equal(d.status, "ok");
  if (d.status !== "ok") return;
  assert.equal(d.olderCount, 2);
});

test("不满 24 小时：闸住（有新批次也不弹）", () => {
  const state = { seenTitle: "2026-11-20 · 十套配色，内网通开群", lastShownAt: NOW - 1000 };
  assert.equal(whatsnewDecision({ text: LOG, state, now: NOW }).status, "throttled");
});

test("正好满 24 小时：放行", () => {
  const state = { seenTitle: "2026-11-20 · 十套配色，内网通开群", lastShownAt: NOW - WHATSNEW_THROTTLE_MS };
  const d = whatsnewDecision({ text: LOG, state, now: NOW });
  assert.equal(d.status, "ok");
  if (d.status !== "ok") return;
  assert.equal(d.olderCount, 0);
});

test("开关关着：一律不弹（哪怕从没看过）", () => {
  const state = { seenTitle: "", lastShownAt: 0, enabled: false };
  assert.equal(whatsnewDecision({ text: LOG, state, now: NOW }).status, "disabled");
});
