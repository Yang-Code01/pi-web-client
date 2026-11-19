/**
 * 按钮可见性（#281 / #288）：哪一颗该画，全页只有这一个纯函数说了算。
 *
 * 三态用「键在不在」表达：缺失 = 默认行为，`false` = 关掉，`true` = 显式打开（窄屏也照开）。
 * 默认行为带两条例外：产物 / 文件管理器要开会话；文件管理器在 `DEFAULT_HIDDEN` 里 —— 键缺失时
 * 不画，要用户在设置里点亮。Everything（`filesearch`）反过来默认画（D331，2026-11-19 用户要求
 * 把两颗的默认对调）。宽度不再参与默认：560px 那条 D138 只在显式 `true` 时还要顶开样式表。
 * 浏览器里「真的少了一颗 / 刷新还在」由 `probes/chrome-topbar.mjs` / `chrome-bottom.mjs` / `chrome-sheet.mjs` / `chrome-narrow.mjs` 把关。
 *
 * Run: node --experimental-transform-types web/tests/chrome-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CHROME_IDS, chromeFrom, isChromeVisible, narrowForcedVisible } from "../src/chrome.ts";

const TOP = ["artifacts", "terminal", "files", "notes", "peer", "scratch", "jira", "mail", "filesearch"];
const BOTTOM = ["skills", "context", "ext", "attach", "model"];
// D331 之后宽度不再参与可见性：这四组「场景」只剩 hasSession 一个维度，名字留着说明覆盖过桌面 / 390。
const DESK = { hasSession: true };
const MOBILE = { hasSession: true };
const EMPTY = { hasSession: false };
const EMPTY_MOBILE = { hasSession: false };

test("14 个稳定 id，顶栏 9 颗、下沿 5 颗", () => {
  assert.deepEqual([...CHROME_IDS], [...TOP, ...BOTTOM]);
});

test("键缺失 = 默认：开了会话、桌面宽，除文件管理器外全画", () => {
  for (const id of CHROME_IDS.filter((x) => x !== "files")) assert.equal(isChromeVisible(id, {}, DESK), true, id);
  // D331：用户 2026-11-19 把两颗的默认对调 —— 文件管理器默认不占顶栏，Everything 默认画。
  assert.equal(isChromeVisible("files", {}, DESK), false, "文件管理器默认不占顶栏");
  assert.equal(isChromeVisible("filesearch", {}, DESK), true, "Everything 默认画");
  assert.equal(isChromeVisible("files", { files: true }, DESK), true, "设置里点亮就出来");
  assert.equal(isChromeVisible("filesearch", { filesearch: false }, DESK), false, "Everything 也能关");
});

test("false = 关掉：桌面 / 窄屏、有会话 / 无会话都不画", () => {
  for (const id of CHROME_IDS) {
    const chrome = { [id]: false };
    for (const ctx of [DESK, MOBILE, EMPTY, EMPTY_MOBILE]) {
      assert.equal(isChromeVisible(id, chrome, ctx), false, `${id} ${JSON.stringify(ctx)}`);
    }
  }
});

test("true = 显式打开：窄屏也照开（D138 的 CSS 由页面顶开）", () => {
  assert.equal(isChromeVisible("files", {}, MOBILE), false, "默认在 390 上也不画文件管理器");
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

test("未知 id 忽略：不认识的照样画（新按钮不需要同步改偏好）", () => {
  assert.equal(isChromeVisible("look", { look: false }, DESK), true);
  assert.equal(isChromeVisible("nonsense", { nonsense: false }, MOBILE), true);
});

test("非布尔值当作没写：退回默认，不被 truthy 骗成 true", () => {
  assert.equal(isChromeVisible("terminal", { terminal: "yes" }, DESK), true, "字符串不算显式");
  assert.equal(isChromeVisible("files", { files: "no" }, MOBILE), false, "字符串也不算显式打开");
  assert.equal(isChromeVisible("files", { files: 1 }, MOBILE), false);
});

test("窄屏强制显示：只有显式 true 的文件管理器要顶开 D138", () => {
  assert.deepEqual(narrowForcedVisible({}), [], "没键 = 不顶开，D138 原样");
  assert.deepEqual(narrowForcedVisible(null), []);
  assert.deepEqual(narrowForcedVisible(undefined), []);
  assert.deepEqual(narrowForcedVisible({ files: true }), ["files"], "显式 true 才顶开");
  assert.deepEqual(narrowForcedVisible({ files: false }), [], "显式 false 是藏，不是顶开");
  assert.deepEqual(narrowForcedVisible({ files: "yes" }), [], "非布尔不算显式");
  assert.deepEqual(narrowForcedVisible({ files: 1 }), []);
  // 只有被 D138 的 CSS 藏掉的才需要标记；其余 10 颗窄屏本来就画。
  const allTrue = Object.fromEntries(CHROME_IDS.map((id) => [id, true]));
  assert.deepEqual(narrowForcedVisible(allTrue), ["files"]);
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
