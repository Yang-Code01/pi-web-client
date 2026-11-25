/**
 * GitHub 通道的前端纯函数（#661）。这一层不碰 DOM：链接识别、相对时间、`+/−` 文案、两个开关的
 * 默认值与「主开关连坐」—— 它们都是「看一眼就知道对不对」的东西，放这里测比靠探针便宜得多。
 *
 * Run: node --experimental-strip-types web/tests/github-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyFrame } from "../src/frames.ts";
import { ghAge, ghBareRefs, ghCardLinks, ghChurn, ghLinksIn, reviewAffordance } from "../src/github-shared.ts";
import { githubFeature } from "../src/github-settings.ts";

test("ghLinksIn：认出 pull / issue / commit，保留仓库与号", () => {
  const links = ghLinksIn(
    "见 https://github.com/acme/widgets/pull/12 与 https://github.com/acme/widgets/issues/7 以及 https://github.com/acme/widgets/commit/abc1234",
  );
  assert.deepEqual(
    links.map((l) => [l.kind, l.repo, l.id]),
    [
      ["pull", "acme/widgets", "12"],
      ["issue", "acme/widgets", "7"],
      ["commit", "acme/widgets", "abc1234"],
    ],
  );
  assert.equal(links[0].url, "https://github.com/acme/widgets/pull/12");
});

test("ghLinksIn：同一条链接出现两次只算一张卡（顺序按第一次出现）", () => {
  const links = ghLinksIn("https://github.com/a/b/pull/1\nhttps://github.com/a/b/pull/1\nhttps://github.com/a/b/pull/2");
  assert.deepEqual(links.map((l) => l.id), ["1", "2"]);
});

test("ghLinksIn：句尾的标点不算进号里，非 github 的链接不认", () => {
  const links = ghLinksIn("看这个 https://github.com/acme/widgets/pull/12。另外 https://gitlab.com/a/b/pull/3");
  assert.equal(links.length, 1);
  assert.equal(links[0].id, "12");
});

test("ghLinksIn：仓库名里有点、横线、下划线也认得出", () => {
  const links = ghLinksIn("https://github.com/my-org.name/repo_1.x/pull/99");
  assert.equal(links.length, 1);
  assert.equal(links[0].repo, "my-org.name/repo_1.x");
});

test("ghBareRefs：正文只写了「PR：**#669**」也认得出（全角冒号 + 加粗的号）", () => {
  // 会话「热部署」那句的原文：#669 只出现在正文里，没有链接，所以以前一张卡都不画。
  const text = "4 条都核实成立，已修完并开了 PR：**#669**（`fix/review-followup` → `main`，commit `b8fe7e8e`）。";
  const refs = ghBareRefs(text, "yang-code01/pi-web-client");
  assert.deepEqual(
    refs.map((r) => [r.kind, r.repo, r.id, r.url, r.weak]),
    [["pull", "yang-code01/pi-web-client", "669", "https://github.com/yang-code01/pi-web-client/pull/669", true]],
  );
});

test("ghBareRefs：PR / pull 后面跟上号的几种写法都认", () => {
  const ids = (t) => ghBareRefs(t, "a/b").map((r) => r.id);
  assert.deepEqual(ids("PR #12"), ["12"]);
  assert.deepEqual(ids("PR: #13"), ["13"]);
  assert.deepEqual(ids("PR：#14"), ["14"]);
  assert.deepEqual(ids("pull #15"), ["15"]);
  assert.deepEqual(ids("PR#16"), ["16"], "号紧贴着也行");
  assert.deepEqual(ids("PR #21 和 pull #22"), ["21", "22"], "一句里两个都认");
  assert.deepEqual(ids("PR #21 又说了一次 PR #21"), ["21"], "同一个号只算一张卡");
});

test("ghBareRefs：裸 #669 和 issue 号不认（本仓库 issue / PR 共用一套编号，猜错就把 issue 说成 PR）", () => {
  assert.deepEqual(ghBareRefs("看下 #669", "a/b"), []);
  assert.deepEqual(ghBareRefs("这个 issue #7 还没修", "a/b"), []);
  assert.deepEqual(ghBareRefs("http://127.0.0.1:7864/#669", "a/b"), [], "URL 片段里的号不是 PR");
});

test("ghBareRefs：会话仓库还没问回来时也给号（repo / url 空着，卡片等判据）", () => {
  assert.deepEqual(ghBareRefs("PR #669", "").map((r) => [r.repo, r.url, r.id, r.weak]), [["", "", "669", true]]);
});

test("ghCardLinks：URL 那张优先（有依据的先画），同号不再猜一张", () => {
  const links = ghCardLinks("PR #669 见 https://github.com/a/b/pull/669", "a/b", 5);
  assert.equal(links.length, 1);
  assert.equal(links[0].url, "https://github.com/a/b/pull/669");
  assert.equal(links[0].weak, undefined, "留下的那张是 URL 来的，不是猜的");
});

test("ghCardLinks：别的仓库同号 URL 不吞掉本仓的猜测卡", () => {
  const links = ghCardLinks("https://github.com/acme/other/pull/669 与 PR #669", "a/b", 5);
  assert.deepEqual(links.map((l) => [l.repo, l.id]), [["acme/other", "669"], ["a/b", "669"]]);
});

test("ghCardLinks：一张卡最多 max 张，URL 排在猜测卡前面", () => {
  const text = "https://github.com/a/b/pull/1 https://github.com/a/b/pull/2 PR #3";
  assert.deepEqual(ghCardLinks(text, "a/b", 2).map((l) => l.id), ["1", "2"]);
  assert.deepEqual(ghCardLinks(text, "a/b", 3).map((l) => l.id), ["1", "2", "3"]);
});

test("ghAge：刚刚 / 分钟 / 小时 / 天 四档", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  assert.deepEqual(ghAge("2026-11-24T11:59:40Z", now), { unit: "now", n: 0 });
  assert.deepEqual(ghAge("2026-11-24T11:30:00Z", now), { unit: "min", n: 30 });
  assert.deepEqual(ghAge("2026-11-24T06:00:00Z", now), { unit: "hour", n: 6 });
  assert.deepEqual(ghAge("2026-11-21T12:00:00Z", now), { unit: "day", n: 3 });
  assert.equal(ghAge("不是时间", now), null, "认不出来就返回 null，让调用方自己决定不显示");
});

test("ghChurn：两样都是 0 时给空串（草稿 PR 常常还没有差异）", () => {
  assert.equal(ghChurn(105, 21), "+105 −21");
  assert.equal(ghChurn(0, 0), "");
  assert.equal(ghChurn(3, 0), "+3 −0");
});

test("设置：主开关默认开，自动弹面板默认关（#666 翻的默认值）", () => {
  assert.deepEqual(githubFeature({}), { cards: true, autoPanel: false });
  assert.deepEqual(githubFeature({ githubCards: true }), { cards: true, autoPanel: false });
  // 只有显式写着 true 才算开：升级上来的老用户没有这个键，也一起回到关。
  assert.deepEqual(githubFeature({ githubAutoPanel: true }), { cards: true, autoPanel: true });
  assert.deepEqual(githubFeature({ githubAutoPanel: false }), { cards: true, autoPanel: false });
});

test("设置：主开关关掉时自动弹面板跟着失效（连坐），不出现「弹了面板却没有卡」", () => {
  assert.deepEqual(githubFeature({ githubCards: false, githubAutoPanel: true }), { cards: false, autoPanel: false });
  assert.deepEqual(githubFeature({ githubCards: false }), { cards: false, autoPanel: false });
});

test("设置：乱值不算「开」（存坏了的偏好别把面板推出来）", () => {
  assert.deepEqual(githubFeature({ githubAutoPanel: 1 }), { cards: true, autoPanel: false });
  assert.deepEqual(githubFeature({ githubAutoPanel: "true" }), { cards: true, autoPanel: false });
});

test("链接卡上的评审钮：只有 PR 卡画（issue / commit 卡不画一颗点了没用的钮）", () => {
  assert.deepEqual(reviewAffordance({ kind: "issue", cardRepo: "a/b", sessionRepo: "a/b" }), { show: false, disabled: false, reason: "" });
  assert.deepEqual(reviewAffordance({ kind: "commit", cardRepo: "a/b", sessionRepo: "a/b" }), { show: false, disabled: false, reason: "" });
});

test("链接卡上的评审钮：同仓可点（仓库名大小写不算差异）", () => {
  assert.deepEqual(reviewAffordance({ kind: "pull", cardRepo: "Acme/Widgets", sessionRepo: "acme/widgets" }), { show: true, disabled: false, reason: "" });
});

test("链接卡上的评审钮：会话仓库还没问回来时先亮着（不是一屏灰再变亮）", () => {
  assert.deepEqual(reviewAffordance({ kind: "pull", cardRepo: "acme/widgets", sessionRepo: "" }), { show: true, disabled: false, reason: "" });
  assert.deepEqual(reviewAffordance({ kind: "pull", cardRepo: "", sessionRepo: "acme/widgets" }), { show: true, disabled: false, reason: "" });
});

test("链接卡上的评审钮：跨仓灰掉并给理由码（桥那边还会再拒一次）", () => {
  assert.deepEqual(reviewAffordance({ kind: "pull", cardRepo: "acme/widgets", sessionRepo: "yang-code01/pi-web-client" }), { show: true, disabled: true, reason: "foreign" });
});

test("帧：github.pr / github.seen 只驱动面板，不改纯视图状态", () => {
  // 改这张表的返回值 = 每次 `gh` 调用都重画左栏/状态行，是实打实的性能回退，所以钉住它。
  assert.deepEqual(applyFrame({ currentId: "s1" }, { type: "github.pr", sessionId: "s1", repo: "a/b", number: 3 }, 0), []);
  assert.deepEqual(applyFrame({ currentId: "s1" }, { type: "github.seen", sessionId: "s1", links: [] }, 0), []);
});
