/**
 * #256：条件模型与 JQL 拼装的纯函数单测。不起 HTTP、不碰 Jira。
 *
 *   node bridge/tests/jira-search-unit.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSearchJql,
  escJql,
  parseSearchParams,
  SearchQueryError,
  SEARCH_PAGE_SIZE,
} from "../src/jira-search.ts";

/** @param {string | Record<string, string>} init */
const parse = (init) => parseSearchParams(new URLSearchParams(init));
/** @param {string | Record<string, string>} init */
const jql = (init) => buildSearchJql(parse(init));

const DEFAULT = "resolution = Unresolved ORDER BY updated DESC";

test("无条件时只筛未解决，按更新时间倒序", () => {
  assert.equal(jql(""), DEFAULT);
  assert.equal(jql({}), DEFAULT);
});

test("每个条件单独出现时拼进固定位置", () => {
  assert.equal(
    jql({ title: "登录 白屏" }),
    'resolution = Unresolved AND summary ~ "登录 白屏" ORDER BY updated DESC',
  );
  assert.equal(
    jql({ text: "支付失败" }),
    'resolution = Unresolved AND text ~ "支付失败" ORDER BY updated DESC',
  );
  assert.equal(
    jql({ project: "ACME" }),
    'resolution = Unresolved AND project = "ACME" ORDER BY updated DESC',
  );
  assert.equal(
    jql({ statusCategory: "indeterminate" }),
    'resolution = Unresolved AND statusCategory = "In Progress" ORDER BY updated DESC',
  );
  assert.equal(
    jql({ project: "ACME", status: "In Progress" }),
    'resolution = Unresolved AND project = "ACME" AND status = "In Progress" ORDER BY updated DESC',
  );
  assert.equal(
    jql({ type: "Bug" }),
    'resolution = Unresolved AND issuetype = "Bug" ORDER BY updated DESC',
  );
  assert.equal(
    jql({ priority: "Highest" }),
    'resolution = Unresolved AND priority = "Highest" ORDER BY updated DESC',
  );
});

test("票号按 workItemKey 前缀匹配，并与其它条件取交集", () => {
  assert.equal(
    jql({ key: "17967" }),
    'workItemKey ~ "17967*" ORDER BY updated DESC',
  );
  assert.equal(
    jql({ title: "登录", key: "17967", project: "ACME" }),
    'workItemKey ~ "17967*" AND summary ~ "登录" AND project = "ACME" ORDER BY updated DESC',
  );
});

test("票号空白省略；通配符由解析层剥掉，用户不能自带 `*` / `?`", () => {
  assert.equal(jql({ key: "   " }), DEFAULT);
  assert.equal(
    jql({ key: " 17*96?7 " }),
    'workItemKey ~ "17967*" ORDER BY updated DESC',
  );
});

test("组合时顺序固定：标题 → 全文本 → 票号 → 项目 → 状态类别 → 状态 → 类型 → 优先级 → 人员 → 未分配", () => {
  assert.equal(
    jql({
      title: "登录",
      text: "白屏",
      project: "ACME",
      statusCategory: "done",
      status: "Done",
      type: "Bug",
      priority: "High",
      personAccountId: "5b10ac8d",
      relations: "assignee,watcher",
      includeResolved: "1",
      sort: "created",
      order: "asc",
    }),
    'summary ~ "登录" AND text ~ "白屏" AND project = "ACME" AND statusCategory = "Done" AND status = "Done" AND issuetype = "Bug" AND priority = "High" AND (assignee = "5b10ac8d" OR watcher = "5b10ac8d") ORDER BY created ASC',
  );
});

test("includeResolved 去掉默认的未解决；没有其它条件时只剩 ORDER BY", () => {
  assert.equal(jql({ includeResolved: "1" }), "ORDER BY updated DESC");
  assert.equal(
    jql({ includeResolved: "1", project: "OPS" }),
    'project = "OPS" ORDER BY updated DESC',
  );
});

test("未分配用 assignee IS EMPTY，且不产生人员组", () => {
  assert.equal(
    jql({ unassigned: "1" }),
    "resolution = Unresolved AND assignee IS EMPTY ORDER BY updated DESC",
  );
});

test("按人查默认三种关系全选，组内 OR；自由文本也走同一条路径", () => {
  assert.equal(
    jql({ person: "林小满" }),
    'resolution = Unresolved AND (assignee = "林小满" OR reporter = "林小满" OR watcher = "林小满") ORDER BY updated DESC',
  );
  assert.equal(
    jql({ person: " 林小满 " }),
    'resolution = Unresolved AND (assignee = "林小满" OR reporter = "林小满" OR watcher = "林小满") ORDER BY updated DESC',
  );
  assert.equal(
    jql({ personAccountId: "abc123", relations: "reporter" }),
    'resolution = Unresolved AND (reporter = "abc123") ORDER BY updated DESC',
  );
});

test("personAccountId 优先于 person", () => {
  assert.equal(
    jql({ person: "someone@example.com", personAccountId: "5b10ac8d", relations: "assignee" }),
    'resolution = Unresolved AND (assignee = "5b10ac8d") ORDER BY updated DESC',
  );
});

test("关系去重但保留给定顺序", () => {
  assert.equal(
    jql({ person: "x", relations: "reporter,assignee,reporter" }),
    'resolution = Unresolved AND (reporter = "x" OR assignee = "x") ORDER BY updated DESC',
  );
});

test("排序：priority 补更新时间作次序，其它不重复", () => {
  assert.equal(
    jql({ sort: "priority" }),
    "resolution = Unresolved ORDER BY priority DESC, updated DESC",
  );
  assert.equal(
    jql({ sort: "priority", order: "asc" }),
    "resolution = Unresolved ORDER BY priority ASC, updated DESC",
  );
  assert.equal(jql({ sort: "updated", order: "asc" }), "resolution = Unresolved ORDER BY updated ASC");
});

test("nextPageToken 原样透传（含空格），空串算没给", () => {
  assert.equal(parse({ nextPageToken: " t 1 " }).nextPageToken, " t 1 ");
  assert.equal(parse({ nextPageToken: "" }).nextPageToken, undefined);
});

test("不按人查时 relations 被忽略，不让空/未知值拖垮整条查询", () => {
  assert.deepEqual(parse({ relations: "" }).relations, []);
  assert.deepEqual(parse({ relations: "assignee,owner" }).relations, []);
});

test("只含控制字符的值转义后为空，按未填处理", () => {
  assert.equal(jql({ title: "\u0000" }), DEFAULT);
  assert.equal(jql({ person: "\u0000" }), DEFAULT);
});

test("未知参数、maxResults 与空值都被忽略", () => {
  assert.equal(jql({ jql: "project = ACME", maxResults: "100" }), DEFAULT);
  assert.equal(jql({ title: "", project: "   " }), DEFAULT);
  assert.equal(SEARCH_PAGE_SIZE, 20);
});

test("引号、反斜杠、换行与控制字符", () => {
  assert.equal(
    jql({ title: 'a"b\\c' }),
    'resolution = Unresolved AND summary ~ "a\\"b\\\\c" ORDER BY updated DESC',
  );
  assert.equal(
    jql({ title: "a\nb" }),
    'resolution = Unresolved AND summary ~ "a b" ORDER BY updated DESC',
  );
  assert.equal(
    jql({ text: "a\tb\u0000c" }),
    'resolution = Unresolved AND text ~ "a b c" ORDER BY updated DESC',
  );
  assert.equal(escJql('x"y\\z'), 'x\\"y\\\\z');
});

test("手工构造的空关系组会被 build 拒绝", () => {
  const params = { ...parse(""), person: "x", relations: [] };
  assert.throws(
    () => buildSearchJql(params),
    (err) => err instanceof SearchQueryError && err.field === "relations",
  );
});

test("非法参数逐条报 jira_query 与字段", () => {
  const reject = (init, field) => {
    assert.throws(
      () => parse(init),
      (err) => {
        assert.ok(err instanceof SearchQueryError);
        assert.equal(err.code, "jira_query");
        assert.equal(err.field, field);
        assert.ok(err.message.length > 0);
        return true;
      },
    );
  };

  reject({ status: "Done" }, "status");
  reject({ person: "a", unassigned: "1" }, "unassigned");
  reject({ person: "a", relations: "" }, "relations");
  reject({ person: "a", relations: "assignee,owner" }, "relations");
  reject({ statusCategory: "progress" }, "statusCategory");
  reject({ sort: "key" }, "sort");
  reject({ order: "down" }, "order");
  reject({ project: "acme" }, "project");
  reject({ project: "A".repeat(11) }, "project");
  reject({ title: "x".repeat(201) }, "title");
  reject({ text: "x".repeat(501) }, "text");
  reject({ person: "x".repeat(201) }, "person");
  reject({ personAccountId: "x".repeat(129) }, "personAccountId");
  reject({ project: "ACME", status: "x".repeat(65) }, "status");
  reject({ nextPageToken: "x".repeat(2049) }, "nextPageToken");
  reject({ key: "x".repeat(501) }, "key");
});

test("项目 key 允许 1–10 位大写字母、数字、下划线", () => {
  assert.equal(
    jql({ project: "A1_B" }),
    'resolution = Unresolved AND project = "A1_B" ORDER BY updated DESC',
  );
  assert.equal(
    jql({ project: "ABCDEFGHIJ" }),
    'resolution = Unresolved AND project = "ABCDEFGHIJ" ORDER BY updated DESC',
  );
});

// ---------------------------------------------------------------- #407 工单号

test("工单号：完整键走精确，单个用 =，多个用 IN，且不再加未解决过滤", () => {
  assert.equal(jql({ key: "CASPH30BUG-21352" }), 'key = "CASPH30BUG-21352" ORDER BY updated DESC');
  // 大小写随用户写：Jira 的 key 本身大小写不敏感，这里统一转大写再拼。
  assert.equal(jql({ key: "casph30bug-21352" }), 'key = "CASPH30BUG-21352" ORDER BY updated DESC');
  assert.equal(
    jql({ key: "CASPH30BUG-1, CASPH30BUG-2、CASPH30BUG-3" }),
    'key IN ("CASPH30BUG-1", "CASPH30BUG-2", "CASPH30BUG-3") ORDER BY updated DESC',
  );
  // 同一个号写两遍只查一次。
  assert.equal(jql({ key: "CASPH30BUG-2 CASPH30BUG-2" }), 'key = "CASPH30BUG-2" ORDER BY updated DESC');
  // 工单号与其它条件 AND，顺序上工单号排最前。
  assert.equal(
    jql({ key: "CASPH30BUG-9", project: "CASPH30BUG", title: "白屏" }),
    'key = "CASPH30BUG-9" AND summary ~ "白屏" AND project = "CASPH30BUG" ORDER BY updated DESC',
  );
  // 勾了「含已解决」也不影响：本来就没有未解决过滤。
  assert.equal(jql({ key: "A-1", includeResolved: "1" }), 'key = "A-1" ORDER BY updated DESC');
});

test("工单号：# 前缀会被去掉，尾部空白无碍", () => {
  assert.equal(jql({ key: "  #CASPH30BUG-7 " }), 'key = "CASPH30BUG-7" ORDER BY updated DESC');
});

test("工单号：半截号 / 纯数字 / 带标题词都判成模糊，走 `workItemKey ~`", () => {
  assert.deepEqual(parse({ key: "2135" }).key, { kind: "fuzzy", token: "2135" });
  // 形如「项目-数字」哪怕号不存在也算完整键（先精确查，查空再退回模糊）。
  assert.deepEqual(parse({ key: "casph30bug-2135" }).key, { kind: "exact", keys: ["CASPH30BUG-2135"] });
  // 只写项目、或者号后面跟着标题词：只拿第一个 token。
  assert.deepEqual(parse({ key: "CASPH30BUG" }).key, { kind: "fuzzy", token: "CASPH30BUG" });
  assert.deepEqual(parse({ key: "21352 白屏" }).key, { kind: "fuzzy", token: "21352" });
  assert.deepEqual(parse({ key: "CASPH30BUG-21352 白屏" }).key, {
    kind: "fuzzy",
    token: "CASPH30BUG-21352",
  });
  // 模糊直接拼进 JQL（D243）：前缀而不是包含，`2135` 不该把 `12135` 一起倒出来。
  assert.equal(jql({ key: "2135" }), 'workItemKey ~ "2135*" ORDER BY updated DESC');
});

test("工单号：空值 / 只有分隔符视为没填", () => {
  assert.deepEqual(parse({ key: "   " }).key, { kind: "none" });
  assert.deepEqual(parse({ key: " , , " }).key, { kind: "none" });
  assert.equal(jql({ key: "" }), DEFAULT);
});

test("工单号：超过 500 字整条查询拒掉", () => {
  assert.throws(() => parse({ key: "x".repeat(501) }), (err) => {
    assert.ok(err instanceof SearchQueryError);
    assert.equal(err.field, "key");
    return true;
  });
});

test("工单号：一次最多 20 个（`key IN` 的上限）", () => {
  const keys = Array.from({ length: 30 }, (_, i) => `ACME-${i + 1}`).join(",");
  const parsed = parse({ key: keys });
  assert.equal(parsed.key.kind, "exact");
  assert.equal(parsed.key.keys.length, 20);
});
