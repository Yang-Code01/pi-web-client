/**
 * Jira 面板的桥端（#248）：假 Jira + 临时状态目录，真跑 HTTP，不碰真的 Atlassian。
 *
 * 覆盖工单要求的那几条「说话算数」：保存前真验证、失败不落盘、页面只见掩码、401/403 分开映射、
 * 隧道只读、头像只认允许名单。`ctx.upstream` 是桥内测试缝 —— 假 Jira 是 `http://127.0.0.1`，
 * 过不了「站点必须 https + 公网域名」的校验，所以出站地址由它顶替；生产不传。
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

const { avatarUrlAllowed, handleJira } = await import("../src/jira.ts");

// ---------------------------------------------------------------- 假 Jira

/** 200 / 401 / 403 由用例改；只实现面板真正会打的两个口子。 */
let jiraMode = "ok";

const jira = http.createServer((req, res) => {
  const url = new URL(req.url, "http://jira.test");
  if (url.pathname !== "/rest/api/3/myself") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ errorMessages: ["not found"] }));
    return;
  }
  if (jiraMode === "401") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ errorMessages: ["Unauthorized; scope does not match"] }));
    return;
  }
  if (jiraMode === "403") {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ errorMessages: ["You do not have permission to view this"] }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      accountId: "acc-1",
      displayName: "Ada Lovelace",
      emailAddress: "ada@acme.com",
      timeZone: "Europe/London",
      // 故意指到白名单外：头像路由必须拒绝，而且不能真去取。
      avatarUrls: { "48x48": "https://evil.example/a.png" },
    }),
  );
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
