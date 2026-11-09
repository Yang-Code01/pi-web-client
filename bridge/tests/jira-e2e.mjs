/**
 * Jira 面板的桥端（#248、#249）：假 Jira + 临时状态目录，真跑 HTTP，不碰真的 Atlassian。
 *
 * 覆盖工单要求的那几条「说话算数」：保存前真验证、失败不落盘、页面只见掩码、401/403 分开映射、
 * 隧道只读、头像只认允许名单；#249 再加上列表的固定 JQL、字段映射、60 秒缓存与 refresh 绕过。
 * `ctx.upstream` 是桥内测试缝 —— 假 Jira 是 `http://127.0.0.1`，过不了「站点必须 https + 公网域名」
 * 的校验，所以出站地址由它顶替；生产不传。
 *
 *   node bridge/tests/jira-e2e.mjs
 *   （Node 22 要加 `--experimental-transform-types`；Node 26 起类型剥离默认开启。）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-jira-e2e-")));
// 状态目录必须是这条用例自己的：写到真的 bridge 状态目录里会污染本机的 Jira 连接。
process.env.PI_WEB_STATE = path.join(tmp, "state");
fs.mkdirSync(process.env.PI_WEB_STATE, { recursive: true });

const { attachmentRedirectAllowed, attachmentRootProblem, avatarUrlAllowed, handleJira, safeFileName } = await import(
  "../src/jira.ts"
);

// ---------------------------------------------------------------- 假 Jira

/** 200 / 401 / 403 由用例改；只实现面板真正会打的那几个口子。 */
let jiraMode = "ok";
/** `search/jql` 单独一档：`ok` / `empty` / `403`。 */
let searchMode = "ok";
/** 上游每被命中一次就 +1：用来断言缓存命中与 `refresh=1` 绕过。#251 再加按附件 id 计数的 content。 */
const hits = { myself: 0, search: 0, projects: 0, issue: 0, comment: 0, content: {} };
/** #251：第二跳（签名 URL 那一跳）收到的 Authorization —— 必须是 null。 */
let secondHopAuth = null;
/** 上游收到的最后一个 `search/jql` 查询串（断言页面传不进来任意查询）。 */
let lastSearch = null;
/** 上游收到的最后一个详情路径（断言 key 已大写化）。 */
let lastIssuePath = "";
/** `ok` / `404`：详情用例单独一档，不影响别的接口。 */
let detailMode = "ok";

const SENTINEL_COMMENT_TEXT = "SENTINEL_COMMENT_TEXT_DO_NOT_LEAK";

const ISSUES = [
  {
    key: "ACME-12",
    fields: {
      summary: "Fix the flux capacitor",
      issuetype: { name: "Bug" },
      priority: { name: "High" },
      status: { name: "In Progress" },
      updated: "2026-11-08T09:30:00.000+0000",
    },
  },
  {
    key: "ACME-9",
    fields: {
      summary: "No priority here",
      issuetype: { name: "Task" },
      priority: null,
      status: { name: "To Do" },
      updated: "2026-11-05T14:02:11.000+0000",
    },
  },
];

const jira = http.createServer((req, res) => {
  const url = new URL(req.url, "http://jira.test");
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const deny = () => {
    if (jiraMode === "401") {
      send(401, { errorMessages: ["Unauthorized; scope does not match"] });
      return true;
    }
    if (jiraMode === "403") {
      send(403, { errorMessages: ["You do not have permission to view this"] });
      return true;
    }
    return false;
  };

  if (url.pathname === "/rest/api/3/search/jql") {
    hits.search++;
    lastSearch = url.searchParams;
    if (deny()) return;
    if (searchMode === "403") return send(403, { errorMessages: ["You do not have permission to view this"] });
    return send(200, { issues: searchMode === "empty" ? [] : ISSUES });
  }
  if (url.pathname === "/rest/api/3/issue/ACME-12") {
    hits.issue++;
    lastIssuePath = url.pathname;
    if (deny()) return;
    if (detailMode === "404") return send(404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
    return send(200, {
      key: "ACME-12",
      fields: {
        summary: "Fix the flux capacitor",
        issuetype: { name: "Bug" },
        priority: { name: "High" },
        status: { name: "In Progress" },
        updated: "2026-11-08T09:30:00.000+0000",
        description: {
          type: "doc",
          version: 1,
          content: [
            { type: "paragraph", content: [{ type: "text", text: "The flux capacitor needs 1.21 gigawatts." }] },
            { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Steps" }] },
          ],
        },
        attachment: [
          {
            id: "att-1",
            filename: "spec.pdf",
            size: 2048,
            author: { displayName: "Ada Lovelace" },
            created: "2026-11-07T10:00:00.000+0000",
          },
          // 上游省掉 size / author：桥要回 null / 空串，不能瞎编。
          { id: "att-2", filename: "mystery.bin" },
        ],
      },
    });
  }
  if (url.pathname === "/rest/api/3/issue/ACME-12/comment") {
    hits.comment++;
    lastIssuePath = url.pathname;
    if (deny()) return;
    if (detailMode === "404") return send(404, { errorMessages: ["Issue does not exist"] });
    const body = (mediaId, alt) => ({
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: SENTINEL_COMMENT_TEXT }] },
        { type: "mediaSingle", content: [{ type: "media", attrs: { id: mediaId, alt, type: "file" } }] },
      ],
    });
    return send(200, {
      comments: [
        {
          id: "c-1",
          author: { displayName: "Grace Hopper" },
          created: "2026-11-08T12:00:00.000+0000",
          body: body("media-9", "screenshot.png"),
        },
        {
          id: "c-2",
          author: { displayName: "Alan Turing" },
          created: "2026-11-08T13:00:00.000+0000",
          // 同一个 media id：去重后只算一条，作者取第一次遇到的评论。
          body: body("media-9", "duplicate.png"),
        },
      ],
    });
  }
  // #251：下载用的工单与附件内容（与 ACME-12 分开，别搅乱 #250 的断言）。
  if (url.pathname === "/rest/api/3/issue/ACME-77") {
    hits.issue++;
    lastIssuePath = url.pathname;
    if (deny()) return;
    return send(200, {
      key: "ACME-77",
      fields: {
        summary: "Attachments to download",
        issuetype: { name: "Task" },
        priority: null,
        status: { name: "To Do" },
        updated: "2026-11-08T10:00:00.000+0000",
        description: null,
        attachment: [
          // 文件名清洗：`: * ? < >` 都要变成 `_`。
          { id: "d-1", filename: "bad:name*?<x>.txt", size: 5 },
          // 同批重名：第二条要加附件 id 后缀。
          { id: "d-2", filename: "same.pdf", size: 5 },
          { id: "d-3", filename: "same.pdf", size: 6 },
          // 超 100 MB：不请求内容，直接跳过。
          { id: "d-4", filename: "huge.bin", size: 150 * 1024 * 1024 },
          // 上游没给 size：边写边数，小文件照常落盘。
          { id: "d-5", filename: "stream.bin" },
          // 评论 media 的 uuid→attachment id 探测用：内容先 302。
          { id: "d-media", filename: "media-source.bin", size: 9 },
          // 跳转到白名单外的 host：必须 failed，不能真去取。
          { id: "d-bad", filename: "evil.bin", size: 4 },
        ],
      },
    });
  }
  if (url.pathname === "/rest/api/3/issue/ACME-77/comment") {
    hits.comment++;
    if (deny()) return;
    return send(200, {
      comments: [
        {
          id: "c-77",
          author: { displayName: "Grace Hopper" },
          created: "2026-11-08T12:00:00.000+0000",
          body: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "mediaSingle",
                content: [{ type: "media", attrs: { id: "media-9", alt: "screenshot.png", type: "file" } }],
              },
            ],
          },
        },
      ],
    });
  }
  // #251：附件内容。按 id 回不同字节；302 指向同一台假 Jira，用来验「第二跳不带 Authorization」。
  const content = /^\/rest\/api\/3\/attachment\/content\/(.+)$/.exec(url.pathname);
  if (content) {
    const id = decodeURIComponent(content[1]);
    hits.content[id] = (hits.content[id] ?? 0) + 1;
    if (id === "media-9") return send(404, { errorMessages: ["Attachment does not exist"] });
    if (id === "d-media") {
      res.writeHead(302, { location: `${jiraBase}/file/media-9/binary` });
      res.end();
      return;
    }
    if (id === "d-bad") {
      res.writeHead(302, { location: "https://evil.example/file/x/binary" });
      res.end();
      return;
    }
    if (id === "d-5") {
      // 故意不给 content-length（chunked）：桥要边写边数。
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end("chunked-body");
      return;
    }
    const bytes = { "d-1": "alpha", "d-2": "first", "d-3": "second", "d-4": "huge" }[id];
    if (bytes === undefined) return send(404, { errorMessages: ["Attachment does not exist"] });
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": Buffer.byteLength(bytes) });
    res.end(bytes);
    return;
  }
  if (url.pathname === "/file/media-9/binary") {
    secondHopAuth = req.headers.authorization ?? null;
    res.writeHead(200, { "content-type": "image/png", "content-length": 9 });
    res.end("png-bytes");
    return;
  }
  if (url.pathname === "/rest/api/3/project/search") {
    hits.projects++;
    if (deny()) return;
    return send(200, {
      values: [
        { key: "ACME", name: "Acme Platform" },
        { key: "OPS", name: "Operations" },
      ],
    });
  }
  if (url.pathname !== "/rest/api/3/myself") return send(404, { errorMessages: ["not found"] });
  hits.myself++;
  if (deny()) return;
  send(200, {
    accountId: "acc-1",
    displayName: "Ada Lovelace",
    emailAddress: "ada@acme.com",
    timeZone: "Europe/London",
    // 故意指到白名单外：头像路由必须拒绝，而且不能真去取。
    avatarUrls: { "48x48": "https://evil.example/a.png" },
  });
});

// ---------------------------------------------------------------- 被测桥

const bridge = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://bridge.test");
  const ctx = { publicReq: req.headers["x-test-tunnel"] === "1", upstream: jiraBase };
  if (await handleJira(req, res, url, ctx)) return;
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "no such route", code: "not_found" }));
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

const jiraBase = await listen(jira);
const bridgeBase = await listen(bridge);
// 处理请求的闭包里读 `jiraBase`：请求只会在两个 listen 之后进来，那时它是确定的。
test.after(() => {
  jira.close();
  bridge.close();
});

async function call(method, route, body, headers = {}) {
  const res = await fetch(bridgeBase + route, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 头像这类不是 JSON */
  }
  return { status: res.status, json, text };
}

// ---------------------------------------------------------------- 状态目录

let stateSeq = 0;
function freshState() {
  const dir = path.join(tmp, `state-${++stateSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.PI_WEB_STATE = dir;
  return dir;
}

function configFile(dir) {
  return path.join(dir, "jira", "config.json");
}

const SITE = "https://acme.atlassian.net";
const EMAIL = "ada@acme.com";
const TOKEN = "ATATT3xFfGF0cdef";

// ---------------------------------------------------------------- 用例

test("未配置时 GET config 回 configured:false", async () => {
  freshState();
  const out = await call("GET", "/api/jira/config");
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { configured: false, siteUrl: "", email: "", keyMask: "" });
});

test("PUT 错 token：400、原话照回、不落盘", async () => {
  const dir = freshState();
  jiraMode = "401";
  const out = await call("PUT", "/api/jira/config", { siteUrl: SITE, email: EMAIL, apiKey: "wrong-token-xyz" });
  assert.equal(out.status, 400);
  assert.equal(out.json.code, "jira_auth");
  assert.match(out.json.error, /Unauthorized; scope does not match/);
  assert.ok(!out.text.includes("wrong-token-xyz"), "响应里不许出现 token");
  assert.equal(fs.existsSync(configFile(dir)), false, "验证失败不该留下配置文件");
});

test("PUT 正确凭据：真验证过才落盘，GET 只回掩码", async () => {
  const dir = freshState();
  jiraMode = "ok";
  const out = await call("PUT", "/api/jira/config", { siteUrl: "acme.atlassian.net/", email: EMAIL, apiKey: TOKEN });
  assert.equal(out.status, 200);
  assert.equal(out.json.ok, true);
  assert.equal(out.json.me.displayName, "Ada Lovelace");
  assert.ok(!out.text.includes(TOKEN), "PUT 的响应里也不许出现 token");

  const file = configFile(dir);
  assert.equal(fs.existsSync(file), true);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(saved, { siteUrl: SITE, email: EMAIL, apiKey: TOKEN });

  const got = await call("GET", "/api/jira/config");
  assert.deepEqual(got.json, { configured: true, siteUrl: SITE, email: EMAIL, keyMask: "••••cdef" });
  assert.ok(!got.text.includes(TOKEN), "GET config 只能回掩码");
});

test("GET me：401 → jira_auth，403 → jira_forbidden", async () => {
  freshState();
  jiraMode = "ok";
  await call("PUT", "/api/jira/config", { siteUrl: SITE, email: EMAIL, apiKey: TOKEN });

  jiraMode = "401";
  const denied = await call("GET", "/api/jira/me");
  assert.equal(denied.status, 401);
  assert.equal(denied.json.code, "jira_auth");

  jiraMode = "403";
  const forbidden = await call("GET", "/api/jira/me");
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.code, "jira_forbidden");

  jiraMode = "ok";
  const ok = await call("GET", "/api/jira/me");
  assert.equal(ok.status, 200);
  assert.equal(ok.json.displayName, "Ada Lovelace");
  assert.equal(ok.json.timezone, "Europe/London");
});

test("未配置时 GET me 说 jira_not_configured", async () => {
  freshState();
  const out = await call("GET", "/api/jira/me");
  assert.equal(out.status, 400);
  assert.equal(out.json.code, "jira_not_configured");
});

test("DELETE 清掉凭据，回到未配置", async () => {
  const dir = freshState();
  jiraMode = "ok";
  await call("PUT", "/api/jira/config", { siteUrl: SITE, email: EMAIL, apiKey: TOKEN });
  assert.equal(fs.existsSync(configFile(dir)), true);

  const out = await call("DELETE", "/api/jira/config");
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { ok: true });
  assert.equal(fs.existsSync(configFile(dir)), false);
  assert.equal((await call("GET", "/api/jira/config")).json.configured, false);
});

test("隧道只读：PUT / DELETE 403，GET 照常", async () => {
  freshState();
  const put = await call("PUT", "/api/jira/config", { siteUrl: SITE, email: EMAIL, apiKey: TOKEN }, { "x-test-tunnel": "1" });
  assert.equal(put.status, 403);
  assert.equal(put.json.code, "tunnel_readonly");

  const del = await call("DELETE", "/api/jira/config", undefined, { "x-test-tunnel": "1" });
  assert.equal(del.status, 403);
  assert.equal(del.json.code, "tunnel_readonly");

  const got = await call("GET", "/api/jira/config", undefined, { "x-test-tunnel": "1" });
  assert.equal(got.status, 200);
});

test("头像地址不在允许名单：502 jira_avatar，不去取", async () => {
  freshState();
  jiraMode = "ok";
  await call("PUT", "/api/jira/config", { siteUrl: SITE, email: EMAIL, apiKey: TOKEN });
  const out = await call("GET", "/api/jira/me/avatar");
  assert.equal(out.status, 502);
  assert.equal(out.json.code, "jira_avatar");
});

test("头像允许名单：站点自己与 Atlassian CDN 放行，其它一律不放", () => {
  assert.equal(avatarUrlAllowed("https://acme.atlassian.net/avatar.png", SITE), true);
  assert.equal(
    avatarUrlAllowed("https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/x.png", SITE),
    true,
  );
  assert.equal(avatarUrlAllowed("https://evil.example/a.png", SITE), false);
  assert.equal(avatarUrlAllowed("http://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/x.png", SITE), false);
  // 带 userinfo / 端口 / fragment 的也拒绝。
  assert.equal(avatarUrlAllowed("https://user:pw@acme.atlassian.net/a.png", SITE), false);
  assert.equal(avatarUrlAllowed("https://acme.atlassian.net:8443/a.png", SITE), false);
  assert.equal(avatarUrlAllowed("https://acme.atlassian.net/a.png#frag", SITE), false);
});

// ---------------------------------------------------------------- #249 列表

/** 连好一个干净状态：缓存随保存清空，计数器归零。 */
async function connect() {
  freshState();
  jiraMode = "ok";
  searchMode = "ok";
  detailMode = "ok";
  await call("PUT", "/api/jira/config", { siteUrl: SITE, email: EMAIL, apiKey: TOKEN });
  hits.myself = 0;
  hits.search = 0;
  hits.projects = 0;
  hits.issue = 0;
  hits.comment = 0;
  hits.content = {};
  secondHopAuth = null;
  lastSearch = null;
  lastIssuePath = "";
}

const FIXED_JQL = "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC";
const FIXED_FIELDS = "summary,issuetype,priority,status,updated";

test("GET issues：固定 JQL + 字段映射（priority 为空回 null）", async () => {
  await connect();
  const out = await call("GET", "/api/jira/issues");
  assert.equal(out.status, 200);
  assert.deepEqual(out.json.issues, [
    {
      key: "ACME-12",
      summary: "Fix the flux capacitor",
      type: "Bug",
      priority: "High",
      status: "In Progress",
      updated: "2026-11-08T09:30:00.000+0000",
    },
    {
      key: "ACME-9",
      summary: "No priority here",
      type: "Task",
      priority: null,
      status: "To Do",
      updated: "2026-11-05T14:02:11.000+0000",
    },
  ]);
  assert.equal(lastSearch.get("jql"), FIXED_JQL);
  assert.equal(lastSearch.get("maxResults"), "20");
  assert.equal(lastSearch.get("fields"), FIXED_FIELDS);
  assert.equal(hits.search, 1);
});

test("GET issues：页面传 jql / fields / startAt 一律被忽略", async () => {
  await connect();
  const out = await call("GET", "/api/jira/issues?jql=project%3DACME&fields=key&startAt=40&maxResults=1");
  assert.equal(out.status, 200);
  assert.equal(lastSearch.get("jql"), FIXED_JQL, "页面传的 jql 不许进入上游请求");
  assert.equal(lastSearch.get("fields"), FIXED_FIELDS);
  assert.equal(lastSearch.get("maxResults"), "20");
  assert.equal(lastSearch.get("startAt"), null);
});

test("GET issues：空列表照常回 { issues: [] }", async () => {
  await connect();
  searchMode = "empty";
  const out = await call("GET", "/api/jira/issues");
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { issues: [] });
});

test("GET issues：401 → jira_auth，403 → jira_forbidden", async () => {
  await connect();
  jiraMode = "401";
  const auth = await call("GET", "/api/jira/issues");
  assert.equal(auth.status, 401);
  assert.equal(auth.json.code, "jira_auth");

  jiraMode = "ok";
  searchMode = "403";
  const forbidden = await call("GET", "/api/jira/issues");
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.code, "jira_forbidden");
  assert.ok(!forbidden.text.includes(TOKEN));
});

test("GET issues：60 秒内复用缓存，refresh=1 再打一次上游", async () => {
  await connect();
  await call("GET", "/api/jira/issues");
  const second = await call("GET", "/api/jira/issues");
  assert.equal(second.status, 200);
  assert.equal(second.json.issues.length, 2, "缓存命中也要回同形的列表");
  assert.equal(hits.search, 1, "两次读取只该打一次上游");

  const forced = await call("GET", "/api/jira/issues?refresh=1");
  assert.equal(forced.status, 200);
  assert.equal(hits.search, 2, "refresh=1 必须绕过缓存");
});

test("GET projects：读 values 的 key/name，缓存与 refresh 同 issues", async () => {
  await connect();
  const first = await call("GET", "/api/jira/projects");
  assert.equal(first.status, 200);
  assert.deepEqual(first.json.projects, [
    { key: "ACME", name: "Acme Platform" },
    { key: "OPS", name: "Operations" },
  ]);
  await call("GET", "/api/jira/projects");
  assert.equal(hits.projects, 1, "两次读取只该打一次上游");
  await call("GET", "/api/jira/projects?refresh=1");
  assert.equal(hits.projects, 2, "refresh=1 必须绕过缓存");
});

test("重新保存凭据会清空列表缓存", async () => {
  await connect();
  await call("GET", "/api/jira/issues");
  assert.equal(hits.search, 1);
  await call("PUT", "/api/jira/config", { siteUrl: SITE, email: EMAIL, apiKey: TOKEN });
  await call("GET", "/api/jira/issues");
  assert.equal(hits.search, 2, "换了凭据不该再吃旧缓存");
});

test("未配置时 GET issues / projects 说 jira_not_configured", async () => {
  freshState();
  for (const route of ["/api/jira/issues", "/api/jira/projects"]) {
    const out = await call("GET", route);
    assert.equal(out.status, 400);
    assert.equal(out.json.code, "jira_not_configured");
  }
});

// ---------------------------------------------------------------- #250 详情

test("GET issues/:key：字段映射，description 原样透传", async () => {
  await connect();
  const out = await call("GET", "/api/jira/issues/ACME-12");
  assert.equal(out.status, 200);
  assert.deepEqual(out.json.issue, {
    key: "ACME-12",
    summary: "Fix the flux capacitor",
    type: "Bug",
    priority: "High",
    status: "In Progress",
    updated: "2026-11-08T09:30:00.000+0000",
    description: {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "The flux capacitor needs 1.21 gigawatts." }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Steps" }] },
      ],
    },
  });
  assert.equal(hits.issue, 1);
  assert.equal(hits.comment, 1);
});

test("GET issues/:key：两段附件（issue + 评论 media），未知大小/作者回 null/空串", async () => {
  await connect();
  const out = await call("GET", "/api/jira/issues/ACME-12");
  assert.deepEqual(out.json.attachments, {
    issue: [
      {
        id: "att-1",
        filename: "spec.pdf",
        size: 2048,
        author: "Ada Lovelace",
        created: "2026-11-07T10:00:00.000+0000",
      },
      { id: "att-2", filename: "mystery.bin", size: null, author: "", created: "" },
    ],
    comments: [
      {
        id: "media-9",
        filename: "screenshot.png",
        size: null,
        author: "Grace Hopper",
        created: "2026-11-08T12:00:00.000+0000",
      },
    ],
  });
});

test("GET issues/:key：响应全文不含评论正文", async () => {
  await connect();
  const out = await call("GET", "/api/jira/issues/ACME-12");
  assert.equal(out.status, 200);
  assert.ok(!out.text.includes(SENTINEL_COMMENT_TEXT), "评论正文不许进入详情响应");
  assert.ok(!out.text.includes('"body"'), "ADF body 原样不许出现");
});

test("GET issues/:key：key 大写化后才拼上游，不合法形状 400 jira_key", async () => {
  await connect();
  const lower = await call("GET", "/api/jira/issues/acme-12");
  assert.equal(lower.status, 200);
  assert.equal(lastIssuePath, "/rest/api/3/issue/ACME-12/comment", "上游只该收到大写 key");

  for (const bad of ["acme", "ACME-", "1ACME-2", "ACME 12", "ACME-12/comment"]) {
    const out = await call("GET", `/api/jira/issues/${encodeURIComponent(bad)}`);
    assert.equal(out.status, 400, `${bad} 应该被拒绝`);
    assert.equal(out.json.code, "jira_key");
  }
  assert.equal(hits.issue, 1, "形状不对的 key 不该打上游");
});

test("GET issues/:key：上游 404 → 404 jira_not_found，401/403 沿用既有码", async () => {
  await connect();
  detailMode = "404";
  const missing = await call("GET", "/api/jira/issues/ACME-12");
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, "jira_not_found");
  assert.match(missing.json.error, /Jira 上没有这个工单/);

  detailMode = "ok";
  jiraMode = "401";
  const auth = await call("GET", "/api/jira/issues/ACME-12");
  assert.equal(auth.status, 401);
  assert.equal(auth.json.code, "jira_auth");

  jiraMode = "403";
  const forbidden = await call("GET", "/api/jira/issues/ACME-12");
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.code, "jira_forbidden");
  assert.ok(!forbidden.text.includes(TOKEN));
});

test("GET issues/:key：不缓存，未配置 400 jira_not_configured", async () => {
  await connect();
  await call("GET", "/api/jira/issues/ACME-12");
  await call("GET", "/api/jira/issues/ACME-12");
  assert.equal(hits.issue, 2, "详情不做缓存（D203）");

  freshState();
  const out = await call("GET", "/api/jira/issues/ACME-12");
  assert.equal(out.status, 400);
  assert.equal(out.json.code, "jira_not_configured");
});

// ---------------------------------------------------------------- #251 下载全部附件

test("GET /api/jira/attachments/root：没设过回 null，不需要先连接 Jira", async () => {
  freshState();
  const out = await call("GET", "/api/jira/attachments/root");
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { root: null });
});

test("PUT root：只收绝对路径，建得出来才保存", async () => {
  await connect();
  const state = process.env.PI_WEB_STATE;
  const relative = await call("PUT", "/api/jira/attachments/root", { root: "jira/attachments" });
  assert.equal(relative.status, 400);
  assert.equal(relative.json.code, "jira_root");
  assert.match(relative.json.error, /绝对路径/);
  assert.ok(!fs.existsSync(path.join(state, "jira", "attachments.json")));

  const root = path.join(tmp, "attach-root-ok");
  const saved = await call("PUT", "/api/jira/attachments/root", { root });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.root, root);
  assert.ok(fs.existsSync(root), "PUT 要把目录建出来");
  assert.deepEqual((await call("GET", "/api/jira/attachments/root")).json, { root });
  // 根目录独立成文件，不写进含 token 的 config.json（D204）。
  assert.ok(fs.existsSync(path.join(state, "jira", "attachments.json")));
  const config = JSON.parse(fs.readFileSync(path.join(state, "jira", "config.json"), "utf8"));
  assert.equal(config.root, undefined);
});

test("PUT root：隧道访客 403 tunnel_readonly，GET 照常", async () => {
  const state = freshState();
  const root = path.join(tmp, "attach-root-tunnel");
  const tunnel = { "x-test-tunnel": "1" };
  const denied = await call("PUT", "/api/jira/attachments/root", { root }, tunnel);
  assert.equal(denied.status, 403);
  assert.equal(denied.json.code, "tunnel_readonly");
  assert.match(denied.json.error, /回本机操作/);
  assert.ok(!fs.existsSync(path.join(state, "jira", "attachments.json")));

  const read = await call("GET", "/api/jira/attachments/root", undefined, tunnel);
  assert.equal(read.status, 200);
  assert.deepEqual(read.json, { root: null });
});

test("POST download：没设根目录 → 400 need_root，一个字节都不写", async () => {
  await connect();
  const state = process.env.PI_WEB_STATE;
  const out = await call("POST", "/api/jira/issues/ACME-77/download");
  assert.equal(out.status, 400);
  assert.equal(out.json.code, "need_root");
  assert.match(out.json.error, /还没设置附件目录/);
  assert.equal(hits.issue, 0, "没目录就别去拉详情");
  assert.ok(!fs.existsSync(path.join(state, "jira", "attachments.json")));
  assert.deepEqual(fs.readdirSync(tmp).filter((name) => name.startsWith("ACME-77")), []);
});

test("POST download：落到 <root>/<KEY>/，清洗 / 重名 / 超限 / 跳转各按规则", async () => {
  await connect();
  const root = path.join(tmp, "attach-root-77");
  await call("PUT", "/api/jira/attachments/root", { root });

  const out = await call("POST", "/api/jira/issues/acme-77/download");
  assert.equal(out.status, 200);
  const dir = path.join(root, "ACME-77");
  assert.equal(out.json.dir, dir);
  assert.ok(fs.existsSync(dir), "KEY 要大写化再建目录");

  const byId = Object.fromEntries(out.json.items.map((item) => [item.id, item]));
  // 文件名清洗：`: * ? < >` 换成 `_`；磁盘上就是这个名字。
  assert.equal(byId["d-1"].status, "saved");
  assert.equal(byId["d-1"].filename, "bad_name___x_.txt");
  assert.equal(fs.readFileSync(path.join(dir, "bad_name___x_.txt"), "utf8"), "alpha");
  // 同批重名：后来的那条加附件 id 后缀。
  assert.equal(byId["d-2"].filename, "same.pdf");
  assert.equal(byId["d-3"].filename, "same-d-3.pdf");
  assert.equal(fs.readFileSync(path.join(dir, "same-d-3.pdf"), "utf8"), "second");
  // 超过 100 MB：跳过并说明，不写文件。
  assert.equal(byId["d-4"].status, "skipped");
  assert.match(byId["d-4"].reason, /100 MB/);
  assert.ok(!fs.existsSync(path.join(dir, "huge.bin")));
  // 上游没给 size：边写边数，小文件照常落盘。
  assert.equal(byId["d-5"].status, "saved");
  assert.equal(fs.readFileSync(path.join(dir, "stream.bin"), "utf8"), "chunked-body");
  // 评论 media：uuid 不是 attachment id，探测对上后重试。
  assert.equal(byId["media-9"].status, "saved");
  assert.equal(byId["media-9"].filename, "screenshot.png");
  assert.equal(fs.readFileSync(path.join(dir, "screenshot.png"), "utf8"), "png-bytes");
  // 跳转到白名单外的 host：失败，不写文件。
  assert.equal(byId["d-bad"].status, "failed");
  assert.match(byId["d-bad"].reason, /不允许的地址/);
  assert.equal(secondHopAuth, null, "第二跳不能带 Authorization");
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    "bad_name___x_.txt",
    "media-source.bin",
    "same-d-3.pdf",
    "same.pdf",
    "screenshot.png",
    "stream.bin",
  ]);
});

test("POST download：重下同一工单是覆盖，不堆副本", async () => {
  await connect();
  const root = path.join(tmp, "attach-root-again");
  await call("PUT", "/api/jira/attachments/root", { root });
  const dir = path.join(root, "ACME-77");
  await call("POST", "/api/jira/issues/ACME-77/download");
  const first = fs.readdirSync(dir).sort();
  const again = await call("POST", "/api/jira/issues/ACME-77/download");
  assert.equal(again.status, 200);
  assert.deepEqual(fs.readdirSync(dir).sort(), first);
  assert.equal(fs.readFileSync(path.join(dir, "same.pdf"), "utf8"), "first");
});

test("POST download：隧道访客 403 tunnel_readonly，不碰磁盘", async () => {
  await connect();
  const state = process.env.PI_WEB_STATE;
  const root = path.join(tmp, "attach-root-tunnel-dl");
  await call("PUT", "/api/jira/attachments/root", { root });
  const out = await call("POST", "/api/jira/issues/ACME-77/download", undefined, { "x-test-tunnel": "1" });
  assert.equal(out.status, 403);
  assert.equal(out.json.code, "tunnel_readonly");
  assert.match(out.json.error, /回本机操作/);
  assert.ok(!fs.existsSync(path.join(root, "ACME-77")));
  assert.ok(fs.existsSync(path.join(state, "jira", "attachments.json")));
});

test("safeFileName：非法字符 / 保留名 / 空名 / 结尾点 / 长度", () => {
  assert.equal(safeFileName("bad:name*?<x>.txt", "d-1"), "bad_name___x_.txt");
  assert.equal(safeFileName("dir/sub\\file.txt", "d-2"), "dir_sub_file.txt");
  assert.equal(safeFileName("CON.txt", "d-3"), "_CON.txt");
  assert.equal(safeFileName("lpt9", "d-4"), "_lpt9");
  assert.equal(safeFileName("  report.pdf.  ", "d-5"), "report.pdf");
  assert.equal(safeFileName("", "d-6"), "attachment-d-6");
  assert.equal(safeFileName("   ", "d-7"), "attachment-d-7");
  const long = safeFileName(`${"a".repeat(200)}.pdf`, "d-8");
  assert.equal(long.length, 120);
  assert.ok(long.endsWith(".pdf"));
  assert.equal(safeFileName("hi\u0001there.txt", "d-9"), "hi_there.txt");
});

test("attachmentRootProblem：只认绝对路径（盘符 / UNC / POSIX）", () => {
  assert.equal(attachmentRootProblem(""), "请填一个附件目录");
  assert.equal(attachmentRootProblem("   "), "请填一个附件目录");
  assert.equal(attachmentRootProblem("jira"), "附件目录要填绝对路径（例如 D:\\jira 或 /home/me/jira）");
  assert.equal(attachmentRootProblem("./out"), "附件目录要填绝对路径（例如 D:\\jira 或 /home/me/jira）");
  assert.equal(attachmentRootProblem("C:\\jira"), null);
  assert.equal(attachmentRootProblem("C:/jira"), null);
  assert.equal(attachmentRootProblem("\\\\nas\\share"), null);
  assert.equal(attachmentRootProblem("/home/me/jira"), null);
});

test("attachmentRedirectAllowed：只认站点自己与 *.atl-paas.net 的 https", () => {
  const site = "https://acme.atlassian.net";
  assert.equal(attachmentRedirectAllowed("https://acme.atlassian.net/file/u1/binary", site), true);
  assert.equal(attachmentRedirectAllowed("https://media.atl-paas.net/file/u1/binary", site), true);
  assert.equal(attachmentRedirectAllowed("https://media.atl-paas.net:443/file/u1/binary", site), true);
  assert.equal(attachmentRedirectAllowed("https://atl-paas.net/file/u1/binary", site), true);
  assert.equal(attachmentRedirectAllowed("http://media.atl-paas.net/file/u1/binary", site), false);
  assert.equal(attachmentRedirectAllowed("https://evil.example/file/u1/binary", site), false);
  assert.equal(attachmentRedirectAllowed("https://media.atl-paas.net.evil.example/f", site), false);
  assert.equal(attachmentRedirectAllowed("https://user:pw@media.atl-paas.net/f", site), false);
  assert.equal(attachmentRedirectAllowed("https://media.atl-paas.net:8443/f", site), false);
  assert.equal(attachmentRedirectAllowed("https://media.atl-paas.net/f#x", site), false);
  assert.equal(attachmentRedirectAllowed("not a url", site), false);
});
