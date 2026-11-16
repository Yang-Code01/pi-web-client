/**
 * Unit: Microsoft OAuth（`bridge/src/mailoauth.ts` + `mailconfig.ts` 的 oauth 部分）。
 *
 * 不碰真微软：设备码 / 刷新令牌这几步都注入假 `fetcher`，只验我们自己这层的规矩 ——
 * 轮询节奏、令牌落盘、令牌不外露、换应用作废旧令牌、失效翻译成 `oauth-needed`。
 *
 *   node --experimental-strip-types bridge/tests/mail-oauth-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mail-oauth-"));
process.env.PI_WEB_STATE = tmp;

const mc = await import("../src/mailconfig.ts");
const oa = await import("../src/mailoauth.ts");

const GUID = "11111111-2222-3333-4444-555555555555";

/** 假的令牌端点：按调用顺序吐回事先准备好的响应，并记下每次请求。 */
function fakeFetcher(responses) {
  const calls = [];
  const fetcher = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    calls.push({ url: String(url), form });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  };
  fetcher.calls = calls;
  return fetcher;
}

/** 把 oauth 账号写进临时状态目录（带好 id），返回读回来的那一份。 */
function seedOAuthAccount(overrides = {}) {
  const { account } = mc.normalizeAccount({
    label: "工作邮箱",
    address: "me@corp.com",
    preset: "m365",
    auth: "oauth",
    oauthClientId: GUID,
    oauthTenant: "common",
    ...overrides,
  });
  assert.ok(account, "normalizeAccount 应该给出一份账号");
  // normalizeAccount 生成的是「还没落盘的账号」（id 空），入库前要盖一个 id（与 /api/mail/accounts 一致）。
  account.id = mc.newAccountId();
  const config = mc.readMailConfig();
  config.accounts = [account];
  mc.writeMailConfig(config);
  const stored = mc.findAccount(mc.readMailConfig(), account.id);
  assert.ok(stored, "账号应该被写进 state 目录");
  return stored;
}

test("预设：Outlook / Microsoft 365 只有 OAuth，别的还是授权码", () => {
  assert.ok(mc.PRESET_IDS.includes("m365"));
  assert.deepEqual(mc.PRESETS.outlook.auth, ["oauth"]);
  assert.deepEqual(mc.PRESETS.m365.auth, ["oauth"]);
  assert.equal(mc.PRESETS.m365.imap.host, "outlook.office365.com");
  assert.equal(mc.PRESETS.m365.imap.port, 993);
  assert.equal(mc.PRESETS.m365.smtp.host, "smtp.office365.com");
  assert.equal(mc.PRESETS.m365.smtp.secure, false);
  // 企业邮没有固定域名：地址整框输，不能按本地部分拼。
  assert.equal(mc.PRESETS.m365.domain, undefined);
  assert.deepEqual(mc.presetAuthMethods("outlook"), ["oauth"]);
  assert.deepEqual(mc.presetAuthMethods("m365"), ["oauth"]);
  assert.deepEqual(mc.presetAuthMethods("163"), ["password"]);
  assert.deepEqual(mc.presetAuthMethods("custom"), ["password"]);
});

test("账号输入：oauth 必须带一串 GUID 客户端 ID", () => {
  const noId = mc.normalizeAccount({ address: "me@corp.com", preset: "m365", auth: "oauth" });
  assert.ok(noId.error && noId.error.includes("客户端 ID"), noId.error);
  const badId = mc.normalizeAccount({ address: "me@corp.com", preset: "m365", auth: "oauth", oauthClientId: "abc" });
  assert.ok(badId.error && badId.error.includes("GUID"), badId.error);
  const good = mc.normalizeAccount({ address: "me@corp.com", preset: "m365", auth: "oauth", oauthClientId: GUID });
  assert.equal(good.account.auth, "oauth");
  assert.equal(good.account.secret, "");
  // 租户留空 → common（多租户应用与个人账号都能登）。
  assert.equal(good.account.oauth.tenant, "common");
  assert.equal(good.account.oauth.refreshToken, "");
  assert.equal(good.account.imap.host, "outlook.office365.com");
});

test("换应用 / 换租户：旧令牌作废；换密码保留授权码语义不变", () => {
  const prev = mc.normalizeAccount({ address: "me@corp.com", preset: "m365", auth: "oauth", oauthClientId: GUID }).account;
  prev.oauth.refreshToken = "R1";
  prev.oauth.accessToken = "A1";
  const same = mc.normalizeAccount({ address: "me@corp.com", preset: "m365", auth: "oauth", oauthClientId: GUID }, prev).account;
  assert.equal(same.oauth.refreshToken, "R1", "同一个应用不该把令牌弄丢");
  const otherApp = mc.normalizeAccount(
    { address: "me@corp.com", preset: "m365", auth: "oauth", oauthClientId: "99999999-2222-3333-4444-555555555555" },
    prev,
  ).account;
  assert.equal(otherApp.oauth.refreshToken, "", "换应用必须清掉旧令牌");
  const otherTenant = mc.normalizeAccount({ address: "me@corp.com", preset: "m365", auth: "oauth", oauthClientId: GUID, oauthTenant: "contoso.com" }, prev).account;
  assert.equal(otherTenant.oauth.refreshToken, "", "换租户必须清掉旧令牌");
});

test("页面拿到的账号：只给 hasToken，令牌不出现", () => {
  const account = seedOAuthAccount();
  const pub = mc.publicAccount(account);
  assert.equal(pub.auth, "oauth");
  assert.equal(pub.hasToken, false);
  assert.equal(pub.hasSecret, false);
  assert.equal(pub.oauthClientId, GUID);
  assert.equal(pub.oauthTenant, "common");
  mc.saveOAuthTokens(account.id, { accessToken: "ACCESS-SECRET", refreshToken: "REFRESH-SECRET", expiresAt: Date.now() + 3600_000, upn: "me@corp.com" });
  const after = mc.publicAccount(mc.findAccount(mc.readMailConfig(), account.id));
  assert.equal(after.hasToken, true);
  assert.equal(after.oauthUpn, "me@corp.com");
  const json = JSON.stringify(after);
  assert.ok(!json.includes("ACCESS-SECRET") && !json.includes("REFRESH-SECRET"), json);
  assert.ok(!json.includes("refreshToken") && !json.includes("accessToken"), json);
});

test("刷新没回 refresh token 时沿用旧值；退出登录只清令牌", () => {
  const account = seedOAuthAccount();
  mc.saveOAuthTokens(account.id, { accessToken: "A1", refreshToken: "R1", expiresAt: 1, upn: "me@corp.com" });
  mc.saveOAuthTokens(account.id, { accessToken: "A2", refreshToken: "", expiresAt: 2, upn: "me@corp.com" });
  let stored = mc.findAccount(mc.readMailConfig(), account.id);
  assert.equal(stored.oauth.refreshToken, "R1");
  assert.equal(stored.oauth.accessToken, "A2");
  assert.equal(mc.clearOAuthTokens(account.id), true);
  stored = mc.findAccount(mc.readMailConfig(), account.id);
  assert.equal(stored.oauth.refreshToken, "");
  assert.equal(stored.oauth.accessToken, "");
  assert.equal(stored.oauth.clientId, GUID, "退出登录不该把应用配置也清掉");
  assert.equal(stored.auth, "oauth");
});

test("设备码登录：pending → done，令牌落盘、upn 从 id_token 里认", async () => {
  const account = seedOAuthAccount();
  const fetcher = fakeFetcher([
    { body: { device_code: "DEV", user_code: "ABCD-EFGH", verification_uri: "https://microsoft.com/devicelogin", expires_in: 900, interval: 2, message: "打开网页输码" } },
    { body: { error: "authorization_pending" } },
    {
      body: {
        access_token: "AT",
        refresh_token: "RT",
        expires_in: 3600,
        id_token: `x.${Buffer.from(JSON.stringify({ preferred_username: "me@corp.com" })).toString("base64url")}.y`,
      },
    },
  ]);
  const login = await oa.startDeviceLogin(account.id, account.oauth, fetcher);
  assert.equal(login.userCode, "ABCD-EFGH");
  assert.equal(login.verificationUri, "https://microsoft.com/devicelogin");
  assert.ok(login.intervalMs >= 2000, "间隔不能被微软的 0 拖成 0");
  assert.match(fetcher.calls[0].url, /\/common\/oauth2\/v2\.0\/devicecode$/);
  assert.equal(fetcher.calls[0].form.scope, oa.M365_SCOPES);

  // 还没到点：不发请求，只让页面接着等。
  const early = await oa.pollDeviceLogin(account.id, fetcher);
  assert.equal(early.status, "pending");
  assert.ok(early.waitMs > 0);
  assert.equal(fetcher.calls.length, 1);

  // 间隔到了：第一次问回 authorization_pending，接着等；第二次拿到令牌。
  await new Promise((r) => setTimeout(r, 2050));
  const stillPending = await oa.pollDeviceLogin(account.id, fetcher);
  assert.equal(stillPending.status, "pending");
  await new Promise((r) => setTimeout(r, 2050));
  const done = await oa.pollDeviceLogin(account.id, fetcher);
  assert.deepEqual(done, { status: "done", upn: "me@corp.com" });

  const stored = mc.findAccount(mc.readMailConfig(), account.id);
  assert.equal(stored.id, account.id, "令牌应该写回同一个账号");
  assert.equal(stored.oauth.refreshToken, "RT");
  assert.equal(stored.oauth.accessToken, "AT");
  assert.equal(stored.oauth.upn, "me@corp.com");
  assert.ok(stored.oauth.expiresAt > Date.now() + 3000_000, "expires_in 要换算成时间戳");
  // 成功后这次登录就结束了，再问就是过期（不能无限挂着）。
  assert.deepEqual(await oa.pollDeviceLogin(account.id, fetcher), { status: "expired" });
});

test("设备码过期与取消：都停掉这次登录", async () => {
  const account = seedOAuthAccount();
  const fetcher = fakeFetcher([{ body: { device_code: "DEV", user_code: "X", verification_uri: "u", expires_in: 900, interval: 2 } }]);
  await oa.startDeviceLogin(account.id, account.oauth, fetcher);
  oa.cancelDeviceLogin(account.id);
  assert.deepEqual(await oa.pollDeviceLogin(account.id, fetcher), { status: "expired" });
});

test("accessTokenFor：没有令牌 / 刷新被撤销都翻成 oauth-needed，能刷新就落盘", async () => {
  const account = seedOAuthAccount();
  await assert.rejects(() => oa.accessTokenFor(account), (err) => err?.code === "oauth-needed");

  const withExpired = { ...account, oauth: { ...account.oauth, refreshToken: "OLD", accessToken: "OLD-AT", expiresAt: Date.now() - 1000 } };
  const ok = fakeFetcher([{ body: { access_token: "NEW-AT", refresh_token: "NEW-RT", expires_in: 3600 } }]);
  assert.equal(await oa.accessTokenFor(withExpired, ok), "NEW-AT");
  assert.match(ok.calls[0].form.grant_type, /refresh_token/);
  const stored = mc.findAccount(mc.readMailConfig(), account.id);
  assert.equal(stored.oauth.accessToken, "NEW-AT");
  assert.equal(stored.oauth.refreshToken, "NEW-RT");

  const revoked = fakeFetcher([{ status: 400, body: { error: "invalid_grant", error_description: "AADSTS700082: The refresh token has expired." } }]);
  await assert.rejects(() => oa.accessTokenFor(withExpired, revoked), (err) => err?.code === "oauth-needed");

  const notExpired = { ...withExpired, oauth: { ...withExpired.oauth, expiresAt: Date.now() + 3600_000 } };
  assert.equal(await oa.accessTokenFor(notExpired, fakeFetcher([])), "OLD-AT", "没过期不该打网络");
});

test("令牌端点错误翻译：客户端 ID 不对 / 没同意 / 权限被拒", async () => {
  const account = seedOAuthAccount();
  const badClient = fakeFetcher([{ status: 400, body: { error: "invalid_client", error_description: "AADSTS700016: Application not found." } }]);
  await assert.rejects(() => oa.startDeviceLogin(account.id, account.oauth, badClient), (err) => {
    assert.equal(err.code, "oauth");
    assert.match(err.hint ?? "", /客户端 ID|租户/);
    return true;
  });
  const noConsent = fakeFetcher([{ status: 400, body: { error: "invalid_grant", error_description: "AADSTS65001: consent required" } }]);
  await assert.rejects(() => oa.startDeviceLogin(account.id, account.oauth, noConsent), (err) => {
    assert.match(err.hint ?? "", /同意/);
    return true;
  });
  const badScope = fakeFetcher([{ status: 400, body: { error: "invalid_scope", error_description: "AADSTS70011: bad scope" } }]);
  await assert.rejects(() => oa.startDeviceLogin(account.id, account.oauth, badScope), (err) => {
    assert.match(err.hint ?? "", /权限/);
    return true;
  });
});

test("失败分类：刷新失效 / 应用不对 / 没同意 / 权限不对各走各的下一步", () => {
  assert.equal(oa.oauthFailureKind("invalid_grant", ""), "revoked");
  assert.equal(oa.oauthFailureKind("", "AADSTS70008: The grant expired"), "revoked");
  assert.equal(oa.oauthFailureKind("invalid_client", ""), "client");
  assert.equal(oa.oauthFailureKind("", "AADSTS700016: Application not found"), "client");
  assert.equal(oa.oauthFailureKind("", "AADSTS65001: consent required"), "consent");
  assert.equal(oa.oauthFailureKind("invalid_scope", ""), "scope");
  assert.equal(oa.oauthFailureKind("temporarily_unavailable", ""), "other");
});

test("并发读信只刷新一次：微软每次刷新都会作废旧 refresh token", async () => {
  const account = seedOAuthAccount();
  mc.saveOAuthTokens(account.id, { accessToken: "OLD", refreshToken: "RT", expiresAt: 1, upn: "me@corp.com" });
  const stored = () => mc.findAccount(mc.readMailConfig(), account.id);
  let served = 0;
  const fetcher = async () => {
    served += 1;
    // 故意慢一点：两个调用方都在等这一次刷新。
    await new Promise((r) => setTimeout(r, 30));
    return new Response(JSON.stringify({ access_token: "NEW", refresh_token: "RT2", expires_in: 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const [a, b] = await Promise.all([oa.accessTokenFor(stored(), fetcher), oa.accessTokenFor(stored(), fetcher)]);
  assert.equal(served, 1, "同一账号的并发刷新应该合并成一次请求");
  assert.equal(a, "NEW");
  assert.equal(b, "NEW");
  assert.equal(stored().oauth.accessToken, "NEW");
  assert.equal(stored().oauth.refreshToken, "RT2");
});

test("OAuth 账号被服务器拒了令牌：下一步是重新登录，不是重新生成授权码", async () => {
  const mt = await import("../src/mailtransport.ts");
  const oauthAcc = seedOAuthAccount();
  const passwordAcc = { ...oauthAcc, auth: "password" };
  const bad = new mt.MailError("auth-failed", "AUTHENTICATIONFAILED", "去邮箱设置里重新生成一个授权码。");
  const fixed = mt.authFailureFor(oauthAcc, bad);
  assert.equal(fixed.code, "oauth-needed");
  assert.ok(fixed.hint.includes("重新登录"), fixed.hint);
  // 授权码账号的行为一个字都不能变。
  assert.equal(mt.authFailureFor(passwordAcc, bad).code, "auth-failed");
  // 不是认证类的错误原样传出去（别把断网说成要重新登录）。
  const net = new mt.MailError("net", "ENOTFOUND", "检查网络");
  assert.equal(mt.authFailureFor(oauthAcc, net).code, "net");
});
