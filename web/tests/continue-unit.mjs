/**
 * 「继续」按钮的三态（D159）。纯函数只有 `continueState()` 一个口 —— 界面上「什么时候灰、
 * 什么时候藏」全部由它决定，`app.ts` 不另写判断。
 *
 * Run: node --experimental-transform-types web/tests/continue-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { continueState } from "../src/continue-state.ts";

const owned = { owned: true, locked: false, starting: false, running: false };

// ---------------------------------------------------------------- 藏

test("只读预览（别人的会话）→ 藏：发不出去，先点接管", () => {
  assert.equal(continueState({ ...owned, owned: false }, true), "hidden");
});

test("终端里另一个 pi 持锁 → 藏", () => {
  assert.equal(continueState({ ...owned, locked: true }, true), "hidden");
});

test("没开会话 → 藏（不是灰）", () => {
  assert.equal(continueState(null, true), "hidden");
  assert.equal(continueState(undefined, true), "hidden");
});

// ---------------------------------------------------------------- 灰

test("pi 正在启动 → 灰", () => {
  assert.equal(continueState({ ...owned, starting: true }, true), "off");
});

test("这一轮还在跑 → 灰（等它停下再继续）", () => {
  assert.equal(continueState({ ...owned, running: true }, true), "off");
});

test("新会话一条用户消息都没有 → 灰", () => {
  assert.equal(continueState(owned, false), "off");
});

test("藏优先于灰：只读 + 运行中仍然是藏", () => {
  assert.equal(continueState({ ...owned, owned: false, running: true }, true), "hidden");
});

// ---------------------------------------------------------------- 可点

test("空闲、有历史 → 可点", () => {
  assert.equal(continueState(owned, true), "ready");
});

test("跑完一轮（running 落回 false）又亮起来：常驻，不只在被打断后出现", () => {
  assert.equal(continueState({ ...owned, running: true }, true), "off");
  assert.equal(continueState({ ...owned, running: false }, true), "ready");
});

test("字段缺省按「不是」算：老桥不发 locked/starting/running 也不该把按钮锁死", () => {
  assert.equal(continueState({ owned: true }, true), "ready");
  assert.equal(continueState({ owned: true, locked: undefined, starting: undefined, running: undefined }, true), "ready");
  assert.equal(continueState({ owned: false }, true), "hidden");
});

// ---------------------------------------------------------------- 后台子代理（D170）

test("后台子代理还在跑 → 灰：pi 回来会自己接着做，点「继续」是插队多推一轮", () => {
  assert.equal(continueState({ ...owned, bg: { n: 1, since: Date.now() } }, true), "off");
});

test("bg 缺省或 n=0 都不拦 —— 老桥不发这个字段，不能因此把按钮锁死", () => {
  assert.equal(continueState({ ...owned, bg: undefined }, true), "ready");
  assert.equal(continueState({ ...owned, bg: { n: 0, since: 1 } }, true), "ready");
});

test("藏优先于后台：只读预览里后台跑着也还是藏", () => {
  assert.equal(continueState({ ...owned, owned: false, bg: { n: 1, since: 1 } }, true), "hidden");
});
