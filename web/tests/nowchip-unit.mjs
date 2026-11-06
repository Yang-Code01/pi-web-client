/**
 * 「当前在哪」那颗（#96）：工作区色点 / 名字 / 读屏文案 的纯函数映射。
 *
 * 只测纯函数层；DOM 那颗在 `probes/nowchip.mjs` 的浏览器探针里把关（收起、展开都在，
 * 切会话立刻变，待处理角标与树里同一套）。颜色不许新造调色板 —— 只能是 #93 之前就有的
 * 六个 accent id。
 *
 * Run: node --experimental-transform-types web/tests/nowchip-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { WS_ACCENTS, nowChipView, wsAccent, wsOf, wsTitle } from "../src/nowchip.ts";

const group = (id, name = "", key = "", manual = false) => ({ id, name, key, manual });
const ws = (over = {}) => ({ groups: [], overrides: {}, keys: {}, ...over });

test("色点稳定：同一个工作区永远同一色，且只从既有六个 accent 里挑", () => {
  for (const id of ["f:/pi-web-client", "f:/other", "manual:abc123", ""]) {
    assert.equal(wsAccent(id), wsAccent(id));
    assert.ok(WS_ACCENTS.includes(wsAccent(id)), `${id} → ${wsAccent(id)} 不在六个 accent 里`);
  }
  assert.deepEqual([...WS_ACCENTS], ["ice", "teal", "violet", "amber", "rose", "slate"]);
});

test("色点不是全挤在一个颜色上：一串真实路径能散开", () => {
  const ids = ["f:/pi-web-client", "f:/pi-web-client-wt/96", "d:/work/a", "d:/work/b", "e:/demo/one", "e:/demo/two", "c:/tmp", "f:/game/engine"];
  const seen = new Set(ids.map(wsAccent));
  assert.ok(seen.size >= 3, `只有 ${seen.size} 种颜色`);
});

test("工作区名：手命名 > 工程根目录名 > 占位", () => {
  assert.equal(wsTitle(group("f:/x/proj", "客户 A", "F:/x/proj", true)), "客户 A");
  assert.equal(wsTitle(group("f:/x/proj", "", "F:/x/proj", false)), "proj");
  assert.equal(wsTitle(group("f:/x/proj", "", "F:\\x\\proj\\", false)), "proj");
  assert.equal(wsTitle(group("manual:abc", "", "", true)), "未命名工作区");
  assert.equal(wsTitle(null), "未分组");
});

test("会话的工作区：列表里的 ws > 覆盖 > 按 cwd 查工程根缓存", () => {
  const groups = [group("f:/x/proj"), group("f:/y/other"), group("manual:m1")];
  const w = ws({ groups, overrides: { "st-2": "manual:m1" }, keys: { "f:/y/other/sub": "F:/y/other" } });

  assert.equal(wsOf({ id: "st-1", name: "一", cwd: "F:/y/other/sub", ws: "f:/y/other" }, w)?.id, "f:/y/other");
  assert.equal(wsOf({ id: "st-2", name: "二", cwd: "F:/y/other/sub" }, w)?.id, "manual:m1");
  // subscribe 回来的 state 不带 ws，但列表里同 id 的那条带着
  assert.equal(wsOf({ id: "st-1", name: "一", cwd: "F:/y/other/sub" }, w, "f:/x/proj")?.id, "f:/x/proj");
  assert.equal(wsOf({ id: "st-1", name: "一", cwd: "F:/y/other/sub" }, w)?.id, "f:/y/other");
  assert.equal(wsOf({ id: "st-9", name: "九", cwd: "Z:/nowhere" }, w), null);
  assert.equal(wsOf(null, w), null);
});

test("读屏念得出「工作区名，会话名，当前会话」", () => {
  const view = nowChipView({
    session: { id: "st-1", name: "追加开发" },
    group: group("f:/pi-web-client", "pi-web-client", "F:/pi-web-client"),
    connected: true,
    running: false,
    owned: true,
    pending: null,
  });
  assert.equal(view.label, "pi-web-client，追加开发，当前会话");
  assert.equal(view.title, view.label);
  assert.equal(view.workspace, "pi-web-client");
  assert.equal(view.name, "追加开发");
  assert.equal(view.accent, wsAccent("f:/pi-web-client"));
});

test("没有工作区也念得通（未分组），没有会话就整颗藏起来", () => {
  const bare = nowChipView({
    session: { id: "st-1", name: "追加开发" },
    group: null,
    connected: false,
    running: false,
    owned: false,
    pending: null,
  });
  assert.equal(bare.label, "追加开发，当前会话");
  assert.equal(bare.workspace, "未分组");
  assert.equal(bare.accent, null);
  assert.equal(bare.hidden, false);

  assert.equal(
    nowChipView({ session: null, group: null, connected: true, running: false, owned: false, pending: null }).hidden,
    true,
  );
});

test("会话名为空时退回 id，不显示一截空白", () => {
  const view = nowChipView({
    session: { id: "st-77", name: "" },
    group: null,
    connected: true,
    running: false,
    owned: false,
    pending: null,
  });
  assert.equal(view.name, "st-77");
});

test("在线点与顶栏那颗同一套优先级：离线 > 运行中 > 本地", () => {
  const base = { session: { id: "st-1", name: "一" }, group: null, pending: null };
  assert.equal(nowChipView({ ...base, connected: false, running: true, owned: true }).live, "bad");
  assert.equal(nowChipView({ ...base, connected: true, running: true, owned: true }).live, "busy");
  assert.equal(nowChipView({ ...base, connected: true, running: false, owned: true }).live, "live");
  assert.equal(nowChipView({ ...base, connected: true, running: false, owned: false }).live, "");
});

test("待处理角标：有就照树里的文案，没有就不占位置", () => {
  const base = { session: { id: "st-1", name: "一" }, group: null, connected: true, running: false, owned: false };
  const pending = { text: "待确认", title: "有 2 个操作要你确认" };
  assert.deepEqual(nowChipView({ ...base, pending }).badge, pending);
  assert.equal(nowChipView({ ...base, pending: null }).badge, null);
});
