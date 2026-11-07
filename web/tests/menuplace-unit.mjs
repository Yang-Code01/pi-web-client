/**
 * 菜单落位（`web/src/menuplace.ts`）：贴着锚点下方开，下方放不下就翻到上面，最后整块夹进窗口。
 *
 * 这张票的 bug 就是这个函数之前不存在：落位只有「贴下方 + 左右夹」，高度完全不看 —— 左栏能滚十几组，
 * 点最底下那组的 ⋯，菜单整块戳出窗口底，「删除工作区」只剩半行。下面每条都是那个窗口尺寸。
 *
 * Run: node --experimental-transform-types web/tests/menuplace-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MENU_MIN_H, placeMenu } from "../src/menuplace.ts";

const VP = { w: 1200, h: 800 };
/** 组头：24px 高，⋯ 在 x 245..265（1400px 窗口里量出来的位置）。 */
const head = (top, height = 24) => ({ left: 245, top, bottom: top + height });
/** 组头 ⋯ 的菜单：212px 宽、169px 高（三条 + 一行原因）。 */
const menu = (h = 169, w = 212) => ({ w, h });

test("下方放得下：贴组头下面 4px 往下开，maxHeight 是这一侧剩下的空间（不含边距）", () => {
  const at = placeMenu(head(200), menu(), VP);
  assert.equal(at.flipped, false);
  assert.equal(at.top, 228);
  assert.equal(at.left, 245);
  assert.equal(at.maxHeight, VP.h - 228 - 8);
});

test("组头贴着窗口底：翻到组头上方，整块留在窗口里", () => {
  const a = head(740); // 740..764，窗口 800
  const at = placeMenu(a, menu(), VP);
  assert.equal(at.flipped, true);
  assert.ok(at.top >= 8, `菜单顶 ${at.top} 钻出了窗口`);
  assert.ok(at.top + 169 <= a.top, `菜单底 ${at.top + 169} 压住了组头 ${a.top}`);
  assert.equal(at.maxHeight, a.top - 4 - 8);
});

test("窗口比菜单还矮：高度按上方剩下的空间封顶，位置仍整个在窗口里", () => {
  const vp = { w: 1200, h: 300 };
  const a = head(200);
  const at = placeMenu(a, menu(), vp);
  assert.equal(at.flipped, true);
  assert.equal(at.maxHeight, 188);
  assert.ok(at.top >= 8 && at.top + 169 <= a.top, `翻转后越界：top=${at.top}`);
});

test("上下都只剩一条缝：封顶也留得住能点的一截（不封到 0），位置仍夹在窗口里", () => {
  const vp = { w: 1200, h: 120 };
  const a = head(60); // 下 48 / 上 48
  const at = placeMenu(a, menu(400), vp);
  assert.equal(at.maxHeight, MENU_MIN_H);
  assert.ok(at.top >= 8, `顶 ${at.top} 出界`);
  assert.ok(at.top + Math.min(400, at.maxHeight) <= vp.h - 8, "封顶后仍然戳出窗口底");
});

test("下方放不下但上方更窄：宁可往下开、封顶（只有上方更宽敞才翻）", () => {
  const a = head(120); // 下方 800-144-12=644，上方 120-12=108
  const at = placeMenu(a, menu(700), VP);
  assert.equal(at.flipped, false);
  assert.equal(at.maxHeight, 644);
});

test("左右夹进窗口：侧栏窄就把菜单收回来，不会戳出右边", () => {
  assert.equal(placeMenu(head(200), menu(), { w: 400, h: 800 }).left, 400 - 212 - 8);
  assert.equal(placeMenu({ ...head(200), left: -50 }, menu(), { w: 400, h: 800 }).left, 8);
});

test("菜单比窗口还宽：退回左边距（.pin-menu 的 max-width 保证实际不会到这一步）", () => {
  // 380 宽：右边只剩 12px 可夹，仍在窗口里；396 宽：夹不下就退回左边距。
  assert.equal(placeMenu(head(200), menu(169, 380), { w: 400, h: 800 }).left, 12);
  assert.equal(placeMenu(head(200), menu(169, 396), { w: 400, h: 800 }).left, 8);
});

test("gap 跟着调用方：置顶条那几颗用 6px，组头 ⋯ 用默认 4px", () => {
  assert.equal(placeMenu(head(200), menu(), VP, { gap: 6 }).top, 230);
  assert.equal(placeMenu(head(200), menu(), VP).top, 228);
});

test("cap: false 的浮层（.ws-pop）只摆位置不封顶，翻转按它自己的高度算", () => {
  // 500px 窗口里一块 350px 高（70vh）的浮层。若按封顶后的 406px 摆，它会白白离开组头 56px。
  const vp = { w: 1200, h: 500 };
  const a = head(420); // 下缘 444，下方只剩 42
  const at = placeMenu(a, { w: 300, h: 350 }, vp, { gap: 6, cap: false });
  assert.equal(at.flipped, true);
  assert.equal(at.top, a.top - 6 - 350, "翻转后底边紧贴组头，不按封顶高度多空一段");
  assert.ok(at.top >= 8, `浮层顶 ${at.top} 钻出了窗口`);
});
