/**
 * 按钮可见性（#281 / #288）：哪一颗该画，全页只有这一个纯函数说了算。
 *
 * 三态用「键在不在」表达：缺失 = 默认行为，`false` = 关掉，`true` = 显式打开（窄屏也照开）。
 * 默认行为本身带两条例外：产物 / 文件管理器要开会话，文件管理器在 560px（D138）以下不进顶栏。
 * 浏览器里「真的少了一颗 / 刷新还在」由 `probes/chrome-visible.mjs` 把关。
 *
 * Run: node --experimental-transform-types web/tests/chrome-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CHROME_IDS, chromeFrom, isChromeVisible } from "../src/chrome.ts";

const TOP = ["artifacts", "terminal", "files", "notes", "peer", "scratch", "jira"];
const BOTTOM = ["skills", "ext", "attach", "model"];
const DESK = { hasSession: true, narrow: false };
const MOBILE = { hasSession: true, narrow: true };
const EMPTY = { hasSession: false, narrow: false };
const EMPTY_MOBILE = { hasSession: false, narrow: true };

test("11 个稳定 id，顶栏 7 颗、下沿 4 颗", () => {
  assert.deepEqual([...CHROME_IDS], [...TOP, ...BOTTOM]);
});

test("键缺失 = 默认：开了会话、桌面宽，11 颗全画", () => {
  for (const id of CHROME_IDS) assert.equal(isChromeVisible(id, {}, DESK), true, id);
});

test("false = 关掉：桌面 / 窄屏、有会话 / 无会话都不画", () => {
  for (const id of CHROME_IDS) {
    const chrome = { [id]: false };
    for (const ctx of [DESK, MOBILE, EMPTY, EMPTY_MOBILE]) {
      assert.equal(isChromeVisible(id, chrome, ctx), false, `${id} ${JSON.stringify(ctx)}`);
    }
  }
});

test("true = 显式打开：连 D138 的窄屏规则也顶开", () => {
  assert.equal(isChromeVisible("files", {}, MOBILE), false, "默认在 390 上不画文件管理器");
  assert.equal(isChromeVisible("files", { files: true }, MOBILE), true, "显式 true 顶开 390");
  assert.equal(isChromeVisible("files", { files: true }, EMPTY_MOBILE), false, "顶开窄屏也换不来一个会话");
  for (const id of TOP.filter((x) => x !== "files")) {
    assert.equal(isChromeVisible(id, { [id]: true }, MOBILE), true, id);
  }
  for (const id of BOTTOM) {
    assert.equal(isChromeVisible(id, { [id]: true }, MOBILE), true, id);
  }
});

test("没开会话：产物与文件管理器不画，其余照旧", () => {
  for (const ctx of [EMPTY, EMPTY_MOBILE]) {
    assert.equal(isChromeVisible("artifacts", {}, ctx), false);
    assert.equal(isChromeVisible("files", { files: true }, ctx), false);
    assert.equal(isChromeVisible("terminal", {}, ctx), true);
    assert.equal(isChromeVisible("notes", {}, ctx), true);
  }
});

test("窄屏只改文件管理器的默认；别的按钮不受宽度影响", () => {
  for (const id of CHROME_IDS.filter((x) => x !== "files")) {
    assert.equal(isChromeVisible(id, {}, MOBILE), true, id);
  }
});

test("未知 id 忽略：不认识的照样画（新按钮不需要同步改偏好）", () => {
  assert.equal(isChromeVisible("look", { look: false }, DESK), true);
  assert.equal(isChromeVisible("nonsense", { nonsense: false }, MOBILE), true);
});

test("非布尔值当作没写：退回默认，不被 truthy 骗成 true", () => {
  assert.equal(isChromeVisible("terminal", { terminal: "yes" }, DESK), true, "字符串不算显式");
  assert.equal(isChromeVisible("files", { files: "no" }, MOBILE), false, "字符串也不算显式打开窄屏");
  assert.equal(isChromeVisible("files", { files: 1 }, MOBILE), false);
});

test("chromeFrom：只收白名单里的布尔值", () => {
  assert.deepEqual(chromeFrom({ terminal: false, files: true, look: false, peer: "yes", nonsense: 1 }), { terminal: false, files: true });
  assert.deepEqual(chromeFrom(undefined), {});
  assert.deepEqual(chromeFrom(null), {});
  assert.deepEqual(chromeFrom([]), {});
  assert.deepEqual(chromeFrom("terminal"), {});
  // 不认识的桥字段原样丢掉，不会在页面状态里留下第二个真相。
  assert.deepEqual(chromeFrom({ terminal: false, showExtButton: false }), { terminal: false });
});
