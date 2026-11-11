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

test("票号按 key 任意位置子串匹配，并与其它条件取交集", () => {
  assert.equal(
    jql({ ticketKey: "17967" }),
    'resolution = Unresolved AND workItemKey ~ "*17967*" ORDER BY updated DESC',
  );
  assert.equal(
    jql({ title: "登录", ticketKey: "17967", project: "ACME" }),
    'resolution = Unresolved AND summary ~ "登录" AND workItemKey ~ "*17967*" AND project = "ACME" ORDER BY updated DESC',
  );
});

test("票号空白省略，合法字符与首尾空白按普通值处理", () => {
  assert.equal(jql({ ticketKey: "   " }), DEFAULT);
  assert.equal(
    jql({ ticketKey: " abc-1_X " }),
    'resolution = Unresolved AND workItemKey ~ "*abc-1_X*" ORDER BY updated DESC',
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
  reject({ ticketKey: "x".repeat(201) }, "ticketKey");
  reject({ ticketKey: "ABC*" }, "ticketKey");
  reject({ ticketKey: "ABC?" }, "ticketKey");
  reject({ ticketKey: "ABC 123" }, "ticketKey");
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
