/**
 * Unit: `bridge/src/changelog.ts` —— 本项目 `CHANGELOG.md` 的结构化解析。
 *
 * 守的是设置页「更新日志」与启动弹窗共用的那份数据：批次怎么切、`### ` 怎么归组、条目末尾的
 * `#N` / `D#` 怎么拆成引用、未发布怎么算、左栏的月份与统计怎么数。
 *
 *   node --experimental-strip-types --test bridge/tests/changelog-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseSelfLog, repoFromRemote } from "../src/changelog.ts";

const LOG = `# pi-web-client 更新日志

这份日志按日期记录变化，最新的一批在最上面。

<!-- 写到 103a01a · 2026-11-20 -->

## 未发布 · 外观只剩 Mac 风格

### 设计决定

- 删掉「配色主题」那七套 #583 D353

## 2026-11-20 · 十套配色，内网通开群

> 这一批得重装，先别走热部署。

### 新增

- 配色主题再添三套 #559 D337
- 内网通开了群聊 #561

### 修复

- 执行面板的 Copilot 积分块（\`#12\` 那种写法不算引用） #564 D338

## 2026-10-02 · 内网通第一批

11-17 晚到 11-18 合进来的这一批。

### 新增

- 附件弹层 #531 D320
`;

test("按 `## ` 分批：注释、大标题与开头那段说明都不进批次", () => {
  const log = parseSelfLog(LOG);
  assert.equal(log.batches.length, 3);
  assert.deepEqual(
    log.batches.map((b) => b.title),
    ["外观只剩 Mac 风格", "十套配色，内网通开群", "内网通第一批"],
  );
  assert.deepEqual(
    log.batches.map((b) => b.date),
    [null, "2026-11-20", "2026-10-02"],
  );
  assert.deepEqual(
    log.batches.map((b) => b.unpublished),
    [true, false, false],
  );
});

test("`### ` 归组成新增 / 修复 / 设计决定，未知标题不丢条目", () => {
  const [first, second] = parseSelfLog(LOG).batches;
  assert.deepEqual(first.groups.map((g) => g.kind), ["design"]);
  assert.deepEqual(second.groups.map((g) => g.kind), ["new", "fix"]);
  const odd = parseSelfLog("## 2026-01-01 · 怪标题\n\n### 其它\n\n- 一条 #1\n").batches[0];
  assert.equal(odd.groups.length, 1);
  assert.equal(odd.groups[0].items.length, 1);
});

test("条目末尾的引用拆成 refs，正文里括号中的编号不动", () => {
  const [, second] = parseSelfLog(LOG).batches;
  const item = second.groups[1].items[0];
  assert.deepEqual(item.refs, [
    { kind: "pr", n: 564 },
    { kind: "d", n: 338 },
  ]);
  assert.equal(item.md, "执行面板的 Copilot 积分块（`#12` 那种写法不算引用）");
  // 只有 PR 的那条
  assert.deepEqual(second.groups[0].items[1].refs, [{ kind: "pr", n: 561 }]);
  assert.deepEqual(second.groups[0].items[1].md, "内网通开了群聊");
});

test("引言：`> ` 的段落标成引用，普通段落也留着", () => {
  const [, quoted, plain] = parseSelfLog(LOG).batches;
  assert.equal(quoted.intro, "这一批得重装，先别走热部署。");
  assert.equal(quoted.introQuoted, true);
  assert.equal(plain.intro, "11-17 晚到 11-18 合进来的这一批。");
  assert.equal(plain.introQuoted, false);
  assert.equal(parseSelfLog(LOG).batches[0].intro, null);
});

test("条目换行续写时接到上一条", () => {
  const batch = parseSelfLog("## 2026-01-01 · 续行\n\n### 新增\n\n- 前半句\n  后半句 #1\n").batches[0];
  assert.equal(batch.groups[0].items.length, 1);
  assert.equal(batch.groups[0].items[0].md, "前半句 后半句");
  assert.deepEqual(batch.groups[0].items[0].refs, [{ kind: "pr", n: 1 }]);
});

test("续行不吞掉首行已经解析出的引用", () => {
  // 首行末尾的 `#1 D9` 已经从 md 里摸走，续行合并时不能再拿「首行 md + 续行」重新拆
  // （那样拆出来只剩续行末尾那一个）。
  const batch = parseSelfLog("## 2026-01-01 · 续行\n\n### 修复\n\n- 首行结尾带引用 #1 D9\n  续行末尾又带两个 #22 D10\n").batches[0];
  assert.deepEqual(batch.groups[0].items[0].refs, [
    { kind: "pr", n: 1 },
    { kind: "d", n: 9 },
    { kind: "pr", n: 22 },
    { kind: "d", n: 10 },
  ]);
  assert.equal(batch.groups[0].items[0].md, "首行结尾带引用 续行末尾又带两个");
});

test("续行没有引用时，首行的引用照样在（统计也算上）", () => {
  const log = parseSelfLog("## 2026-01-01 · 续行\n\n### 新增\n\n- 条目 #7\n  普通的一行说明，没有引用\n");
  assert.deepEqual(log.batches[0].groups[0].items[0].refs, [{ kind: "pr", n: 7 }]);
  assert.equal(log.stats.prs, 1);
});

test("月份与统计：未发布不计月份，PR 去重", () => {
  const log = parseSelfLog(LOG);
  assert.deepEqual(log.months, [
    { key: "2026-11", year: 2026, month: 11, count: 1 },
    { key: "2026-10", year: 2026, month: 10, count: 1 },
  ]);
  assert.deepEqual(log.stats, { batches: 3, items: 5, prs: 5, unpublished: 1 });
});

test("同一批里重复的 PR 只算一个，月份按降序", () => {
  const log = parseSelfLog(
    ["## 2026-02-01 · a", "", "### 新增", "", "- x #7", "- y #7", "", "## 2026-01-01 · b", "", "### 修复", "", "- z #7"].join("\n"),
  );
  assert.equal(log.stats.prs, 1);
  assert.deepEqual(
    log.months.map((m) => m.key),
    ["2026-02", "2026-01"],
  );
});

test("空文件 / 只有大标题：空表，不抛", () => {
  for (const text of ["", "# 只有大标题\n", "\n\n\n"]) {
    const log = parseSelfLog(text);
    assert.deepEqual(log.batches, []);
    assert.deepEqual(log.months, []);
    assert.deepEqual(log.stats, { batches: 0, items: 0, prs: 0, unpublished: 0 });
  }
});

test("CRLF 与 BOM 不影响分批", () => {
  const text = "\uFEFF# 日志\r\n\r\n## 2026-01-01 · 主题\r\n\r\n### 修复\r\n\r\n- 一条 #3\r\n";
  const log = parseSelfLog(text);
  assert.equal(log.batches.length, 1);
  assert.equal(log.batches[0].groups[0].items[0].md, "一条");
  assert.deepEqual(log.batches[0].groups[0].items[0].refs, [{ kind: "pr", n: 3 }]);
});

test("`## 2026-01-01` 没有主题：标题为空，日期照认", () => {
  const batch = parseSelfLog("## 2026-01-01\n\n### 新增\n\n- 一条 #2\n").batches[0];
  assert.equal(batch.date, "2026-01-01");
  assert.equal(batch.title, "");
  assert.equal(batch.unpublished, false);
});

test("引用与远程地址", () => {
  assert.deepEqual(repoFromRemote("git@github.com:Yang-Code01/pi-web-client.git\n"), {
    owner: "Yang-Code01",
    name: "pi-web-client",
  });
  assert.deepEqual(repoFromRemote("https://github.com/Yang-Code01/pi-web-client.git"), {
    owner: "Yang-Code01",
    name: "pi-web-client",
  });
  assert.deepEqual(repoFromRemote("ssh://git@github.com/Yang-Code01/pi-web-client.git"), {
    owner: "Yang-Code01",
    name: "pi-web-client",
  });
  assert.equal(repoFromRemote("https://gitee.com/a/b.git"), null);
  assert.equal(repoFromRemote(""), null);
});
