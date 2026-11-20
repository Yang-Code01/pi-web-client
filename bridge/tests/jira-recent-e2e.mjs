/**
 * Jira 面板「最近消息」的桥端：`GET /api/jira/recent?kind=mentions|replied`。
 * 假 Jira + 临时状态目录，真跑 HTTP。覆盖：固定 JQL（页面传不进查询）、按定位评论的时间排序、
 * 只挑「别人 @ 我」/「我自己写」的那条、单张工单读不到评论只跳过、60 秒缓存与 refresh、坏 kind 400。
 *
 *   node bridge/tests/jira-recent-e2e.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-jira-recent-")));
process.env.PI_WEB_STATE = path.join(tmp, "state");
fs.mkdirSync(process.env.PI_WEB_STATE, { recursive: true });

const { handleJira, recentJql, adfMentions, pickRecentComment } = await import("../src/jira.ts");

const ME = "acc-me";
const issue = (key, updated) => ({
  key,
  fields: { summary: `S ${key}`, issuetype: { name: "Bug" }, priority: null, status: { name: "Open" }, assignee: null, updated },
});
const mention = (id) => ({ type: "mention", attrs: { id, text: "@x" } });
const doc = (...content) => ({ type: "doc", content: [{ type: "paragraph", content }] });
const text = (t) => ({ type: "text", text: t });
const comment = (id, who, created, body) => ({ id, author: { accountId: who, displayName: who }, created, body });

// 评论按新到旧（上游 orderBy=-created）
const COMMENTS = {
  "A-1": [
    comment("13", ME, "2026-11-20T10:00:00.000+0900", doc(text("my reply"))),
    comment("12", "bob", "2026-11-19T09:00:00.000+0900", doc(text("hey "), mention(ME))),
  ],
  "A-2": [comment("21", "carol", "2026-11-20T12:00:00.000+0900", doc(mention(ME), text(" pls check")))],
  // 我自己 @ 自己不算；只有字段改动、没评论的也不算
  "A-3": [comment("31", ME, "2026-11-18T08:00:00.000+0900", doc(mention(ME)))],
  "A-4": [],
  "A-5": "403",
};

let lastJql = "";
const hits = { search: 0, comment: 0 };
const jira = http.createServer((req, res) => {
  const url = new URL(req.url, "http://jira.test");
  const send = (s, b) => {
    res.writeHead(s, { "content-type": "application/json" });
    res.end(JSON.stringify(b));
  };
  if (url.pathname === "/rest/api/3/myself") return send(200, { accountId: ME, displayName: "Me" });
  if (url.pathname === "/rest/api/3/search/jql") {
    hits.search++;
    lastJql = url.searchParams.get("jql") ?? "";
    return send(200, {
      issues: ["A-1", "A-2", "A-3", "A-4", "A-5"].map((k) => issue(k, "2026-11-20T13:00:00.000+0900")),
      isLast: true,
    });
  }
  const m = url.pathname.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/comment$/);
  if (m) {
    hits.comment++;
    assert.equal(url.searchParams.get("orderBy"), "-created");
    const c = COMMENTS[m[1]];
    if (c === "403") return send(403, { errorMessages: ["nope"] });
    return send(200, { comments: c ?? [], total: (c ?? []).length });
  }
  send(404, { errorMessages: ["not found"] });
});

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${s.address().port}`)));
const jiraBase = await listen(jira);
const bridge = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://bridge.test");
  if (await handleJira(req, res, url, { publicReq: false, upstream: jiraBase })) return;
  res.writeHead(404);
  res.end();
});
const bridgeBase = await listen(bridge);
test.after(() => {
  jira.close();
  bridge.close();
});

async function call(method, route, body) {
  const res = await fetch(bridgeBase + route, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

await call("PUT", "/api/jira/config", { siteUrl: "https://acme.atlassian.net", email: "me@acme.com", apiKey: "tok-123456" });

test("JQL 由桥写死；accountId 形状不对就不拼", () => {
  assert.equal(recentJql("mentions", ME), `comment ~ "${ME}" ORDER BY updated DESC`);
  assert.equal(recentJql("replied", ME), `issuekey in updatedBy("${ME}", "-90d") ORDER BY updated DESC`);
  assert.throws(() => recentJql("mentions", 'x" OR 1=1'));
});

test("adfMentions / pickRecentComment", () => {
  assert.equal(adfMentions(doc(text("a"), mention(ME)), ME), true);
  assert.equal(adfMentions(doc(mention("other")), ME), false);
  assert.equal(pickRecentComment("mentions", COMMENTS["A-1"], ME)?.id, "12");
  assert.equal(pickRecentComment("replied", COMMENTS["A-1"], ME)?.id, "13");
  assert.equal(pickRecentComment("mentions", COMMENTS["A-3"], ME), null);
});

test("mentions：别人 @ 我的那条，按评论时间新到旧；读不到评论的工单只跳过", async () => {
  const out = await call("GET", "/api/jira/recent?kind=mentions&jql=project%3DX");
  assert.equal(out.status, 200);
  assert.ok(lastJql.startsWith("comment ~"), "页面传的 jql 被忽略");
  assert.deepEqual(out.json.items.map((x) => [x.key, x.comment.id, x.comment.author]), [
    ["A-2", "21", "carol"],
    ["A-1", "12", "bob"],
  ]);
  assert.equal(out.json.skipped, 1);
  assert.equal(out.json.items[0].summary, "S A-2");
  assert.equal(out.json.items[0].comment.body.type, "doc");
});

test("replied：我写的最新一条；只改字段的工单不出现", async () => {
  const out = await call("GET", "/api/jira/recent?kind=replied");
  assert.equal(out.status, 200);
  assert.ok(lastJql.includes("updatedBy"));
  assert.deepEqual(out.json.items.map((x) => [x.key, x.comment.id]), [
    ["A-1", "13"],
    ["A-3", "31"],
  ]);
});

test("60 秒缓存；refresh=1 绕过", async () => {
  const before = hits.search;
  await call("GET", "/api/jira/recent?kind=mentions");
  assert.equal(hits.search, before, "缓存命中不打上游");
  await call("GET", "/api/jira/recent?kind=mentions&refresh=1");
  assert.equal(hits.search, before + 1);
});

test("坏 kind 400；非 GET 405", async () => {
  assert.equal((await call("GET", "/api/jira/recent?kind=all")).status, 400);
  assert.equal((await call("POST", "/api/jira/recent?kind=mentions")).status, 405);
});
