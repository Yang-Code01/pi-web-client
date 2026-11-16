/**
 * Unit: 邮箱的权限与 HTTP 面（`bridge/src/mailconfig.ts` + `bridge/src/mail.ts`）。
 *
 * 不碰真邮箱：只测「允不允许」和「路由回什么」。IMAP / SMTP 的连接留给 e2e（`test:mail:ui`）。
 * 状态目录用临时目录（`PI_WEB_STATE`），跑完删掉。
 *
 *   node --experimental-strip-types bridge/tests/mail-unit.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mail-unit-"));
process.env.PI_WEB_STATE = tmp;

const mc = await import("../src/mailconfig.ts");
const mail = await import("../src/mail.ts");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------- policyDenial

const base = mc.readMailConfig();
check("空目录 → DEFAULT_POLICY", JSON.stringify(base.policy) === JSON.stringify(mc.DEFAULT_POLICY));
check("默认允许读信", mc.policyDenial(base, "read") === null);
check("默认允许发信（但要确认）", mc.policyDenial(base, "send") === null && base.policy.confirmSend === true);
check("默认不许取附件", mc.policyDenial(base, "attachments") === "policy-denied:attachments");
check("默认不许改邮箱状态", mc.policyDenial(base, "mutate") === "policy-denied:mutate");

const noRead = { ...base, policy: { ...base.policy, read: false } };
check("关掉 read → policy-denied:read", mc.policyDenial(noRead, "read") === "policy-denied:read");
check("拒绝的话能给人看", mc.denialText("policy-denied:read").includes("读邮件"), mc.denialText("policy-denied:read"));

const acct = { id: "m1", label: "a", address: "a@163.com", preset: "163", imap: { host: "imap.163.com", port: 993, secure: true }, smtp: { host: "smtp.163.com", port: 465, secure: true }, user: "a@163.com", secret: "x".repeat(16), enabled: true, verifiedAt: null, lastError: null };
const limited = { ...base, policy: { ...base.policy, accountIds: ["m2"] } };
check("账号不在白名单 → policy-denied:account", mc.policyDenial(limited, "read", acct) === "policy-denied:account");
const disabled = { ...base, accounts: [], policy: { ...base.policy }, defaultAccount: null };
check("停用账号 → no-account", mc.policyDenial(disabled, "read", { ...acct, enabled: false }) === "no-account");

// ---------------------------------------------------------------- 白名单

const open = { ...base, policy: { ...base.policy, recipients: [] } };
check("空白名单不拦", mc.recipientsDenied(open, ["anyone@example.com"]).length === 0);
const allow = { ...base, policy: { ...base.policy, recipients: ["boss@corp.com", "@partner.io"] } };
check("整串命中放行", mc.recipientsDenied(allow, ["BOSS@corp.com"]).length === 0);
check("域名后缀命中放行", mc.recipientsDenied(allow, ["x@partner.io"]).length === 0);
check("名单外被拦且回地址", JSON.stringify(mc.recipientsDenied(allow, ["x@evil.com"])) === '["x@evil.com"]');
check("不像地址的被拦", mc.recipientsDenied(allow, ["nope"]).length === 1);

// ---------------------------------------------------------------- 掩码与审计

const pub = mc.publicAccount(acct);
check("回给页面的账号不含 secret", !("secret" in pub), Object.keys(pub).join(","));
check("只给掩码", typeof pub.secretMask === "string" && !pub.secretMask.includes("xxxxxxxx"));
check("没有授权码时 hasSecret=false", mc.publicAccount({ ...acct, secret: "" }).hasSecret === false);

mc.appendAudit({ t: Date.now(), account: "m1", from: "a@163.com", to: ["b@x.com"], subject: "hi", by: "agent", ok: true });
mc.appendAudit({ t: Date.now() - 86400_000 * 2, account: "m1", from: "a@163.com", to: ["b@x.com"], subject: "old", by: "agent", ok: true });
check("今日计数只数今天", mc.sentToday("m1") === 1, String(mc.sentToday("m1")));
check("审计读得回来", mc.recentAudit(5).length === 2);
check("审计文件存在", fs.statSync(mc.mailAuditFile()).isFile());
if (process.platform !== "win32") {
  // Windows 上 chmod 只影响只读位，mode 恒为 666，这条只能在 POSIX 上验。
  check("审计文件权限 0600", (fs.statSync(mc.mailAuditFile()).mode & 0o777).toString(8) === "600", (fs.statSync(mc.mailAuditFile()).mode & 0o777).toString(8));
}

// ---------------------------------------------------------------- normalizeAccount

const ok163 = mc.normalizeAccount({ address: "me@163.com", secret: "abcd efgh ijkl mnop", preset: "163" });
check("163 预设自动补端点", ok163.account?.imap.host === "imap.163.com" && ok163.account?.smtp.host === "smtp.163.com");
check("授权码去空格", ok163.account?.secret === "abcdefghijklmnop", ok163.account?.secret);
check("登录账号默认等于地址", ok163.account?.user === "me@163.com");
check("地址不像地址就报错", mc.normalizeAccount({ address: "nope" }).error?.includes("地址") === true);
check("custom 缺服务器就报错", mc.normalizeAccount({ address: "a@b.co", preset: "custom" }).error?.includes("IMAP") === true);

const prev = { ...acct, secret: "abcdefghijklmnop" };
const maskedInput = mc.normalizeAccount({ id: "m1", address: "a@163.com", secret: mc.maskSecret(prev.secret) }, prev);
check("回传掩码 = 不改授权码", maskedInput.account?.secret === prev.secret, maskedInput.account?.secret);

// ---------------------------------------------------------------- handleMail 路由

function fakeRes() {
  const out = { status: 0, body: null, headers: {} };
  const res = {
    writeHead(status, headers) {
      out.status = status;
      Object.assign(out.headers, headers ?? {});
      return res;
    },
    setHeader(k, v) {
      out.headers[k] = v;
    },
    end(chunk) {
      if (chunk) {
        try {
          out.body = JSON.parse(String(chunk));
        } catch {
          out.body = String(chunk);
        }
      }
    },
  };
  return { res, out };
}

function fakeReq(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = { "content-type": "application/json" };
  return req;
}

const ctx = { publicReq: false, confirm: async () => ({ ok: true }) };

async function call(method, p, body, extra = {}) {
  const { res, out } = fakeRes();
  const handled = await mail.handleMail(fakeReq(method, body), res, new URL(`http://127.0.0.1:7864${p}`), { ...ctx, ...extra });
  return { handled, ...out };
}

let r = await call("GET", "/api/mail/config");
check("GET config 被认领", r.handled === true);
check("config 初始没有账号", Array.isArray(r.body?.accounts) && r.body.accounts.length === 0, JSON.stringify(r.body?.accounts));
check("config 带回预设表", Array.isArray(r.body?.presetIds) && r.body.presetIds.includes("163"));
check("个人邮箱预设带回默认域名", r.body?.presets?.["163"]?.domain === "163.com" && r.body?.presets?.gmail?.domain === "gmail.com");
check("企业邮与自定义不猜域名", !r.body?.presets?.qiye163?.domain && !r.body?.presets?.custom?.domain);

r = await call("POST", "/api/mail/accounts", { address: "me@163.com", preset: "163", secret: "abcdefghijklmnop", label: "工作" });
check("加账号 200", r.status === 200 && r.body?.ok === true, String(r.status));
check("加账号只回掩码", !JSON.stringify(r.body).includes("abcdefghijklmnop"), JSON.stringify(r.body?.account));
const accId = r.body?.account?.id;

r = await call("POST", "/api/mail/accounts", { address: "me@163.com", preset: "163", secret: "abcdefghijklmnop" });
check("重复地址 400 duplicate", r.status === 400 && r.body?.code === "duplicate", `${r.status} ${r.body?.code}`);

// ---------------------------------------------------------------- OAuth 路由
//
// 这几个口子不做网络请求就能验：账号不对 / 不是 oauth 账号 / 方法不对，都在发请求之前就回。
r = await call("POST", "/api/mail/oauth/start", { accountId: accId });
check("授权码账号去登录 → 400 bad_input", r.status === 400 && r.body?.code === "bad_input", `${r.status} ${r.body?.code}`);
r = await call("POST", "/api/mail/oauth/start", { accountId: "nope" });
check("没有这个账号 → 404", r.status === 404 && r.body?.code === "not_found", `${r.status} ${r.body?.code}`);
r = await call("GET", "/api/mail/oauth/start", undefined);
check("登录只收 POST（405）", r.status === 405 && r.body?.code === "bad_method", `${r.status} ${r.body?.code}`);

r = await call("POST", "/api/mail/accounts", {
  address: "me@corp.com",
  preset: "m365",
  auth: "oauth",
  oauthClientId: "11111111-2222-3333-4444-555555555555",
  oauthTenant: "common",
});
check("存一个 oauth 账号 200", r.status === 200 && r.body?.account?.auth === "oauth", `${r.status} ${r.body?.code ?? ""}`);
check("刚存的 oauth 账号还没登录（hasToken false）", r.body?.account?.hasToken === false);
check("oauth 账号不用给授权码", r.body?.account?.hasSecret === false);
const oauthId = r.body?.account?.id;
r = await call("POST", "/api/mail/oauth/nope", { accountId: oauthId });
check("未知 oauth 动作 → 404", r.status === 404 && r.body?.code === "not_found", `${r.status} ${r.body?.code}`);
r = await call("POST", "/api/mail/accounts", { address: "me2@corp.com", preset: "m365", auth: "oauth" });
check("新建 oauth 账号不给客户端 ID 就是 400", r.status === 400 && r.body?.code === "bad_input", `${r.status} ${r.body?.code}`);
r = await call("POST", "/api/mail/accounts", { id: oauthId, address: "me@corp.com", preset: "m365" });
check("改存时不给客户端 ID 就沿用原来的（不是 400）", r.status === 200 && r.body?.account?.oauthClientId === "11111111-2222-3333-4444-555555555555", `${r.status} ${r.body?.account?.oauthClientId}`);
await call("DELETE", `/api/mail/accounts/${oauthId}`);

r = await call("POST", "/api/mail/policy", { send: false });
check("改权限 200", r.status === 200 && r.body?.policy?.send === false, JSON.stringify(r.body?.policy));
r = await call("GET", "/api/mail/config");
check("改完读回来是新的", r.body?.policy?.send === false);

r = await call("POST", "/api/mail/policy", { read: false });
check("关掉读权限 200", r.body?.policy?.read === false);
// D264：「AI 权限」只管 AI。页面自己看信不该被它拦住 —— 以前这里直接 403 policy-denied:read，
// 把「读邮件」一关，连人自己在面板里都看不了信。现在过了闸、落到参数校验（缺 uid）。
r = await call("GET", "/api/mail/message");
check("读权限关着，页面也照样能读（只是参数不对）", r.status === 400 && r.body?.code === "bad_input", `${r.status} ${r.body?.code}`);
await call("POST", "/api/mail/policy", { read: true });

r = await call("GET", "/api/mail/message?folder=INBOX");
check("缺 uid 才回 400（以前 Number(null)=0 会漏过去）", r.status === 400 && r.body?.code === "bad_input", `${r.status} ${r.body?.code}`);

r = await call("GET", "/api/mail/config", undefined, { publicReq: true });
check("隧道访客 403", r.status === 403 && r.body?.code === "tunnel_readonly", String(r.body?.code));

r = await call("GET", "/api/mail/nope");
check("未知路径也认领（不回落到别的路由）", r.handled === true);

// ---------------------------------------------------------------- 权限只管 AI（D264）
//
// 不发真的信：靠「参数错」与「连不上」两种短路。第二条用一个指向 127.0.0.1:9 的账号，
// ECONNREFUSED 立刻回来，不会真的上网。

r = await call("POST", "/api/mail/accounts", {
  address: "nobody@example.com",
  preset: "custom",
  secret: "abcdefghijklmnop",
  label: "打不通的",
  imap: { host: "127.0.0.1", port: 9, secure: false },
  smtp: { host: "127.0.0.1", port: 9, secure: false },
});
const deadId = r.body?.account?.id;
check("加一个连不上的账号", r.status === 200 && !!deadId, `${r.status} ${r.body?.code ?? ""}`);

r = await call("POST", "/api/mail/policy", { send: false });
check("关掉发信权限", r.body?.policy?.send === false);
r = await call("POST", "/api/mail/send", { account: deadId, to: "nope", subject: "x", text: "y" });
check("页面发信不看 AI 权限（落到参数错，不是 403）", r.status === 400 && r.body?.code === "bad-input", `${r.status} ${r.body?.code}`);
{
  const { res, out } = fakeRes();
  await mail.handleMailTool(
    fakeReq("POST", { token: "t1", args: { account: deadId, to: "a@b.com", subject: "x", text: "y" } }),
    res,
    new URL("http://127.0.0.1:7864/api/mail/tool/mail_send"),
    { publicReq: false, byToken: () => ({ id: "s1" }), confirm: async () => ({ ok: true }) },
  );
  check("AI 发信仍然被 policy-denied:send 拦住", out.body?.code === "policy-denied:send", String(out.body?.code));
}
await call("POST", "/api/mail/policy", { send: true, recipients: ["boss@corp.com"] });
{
  const { res, out } = fakeRes();
  await mail.handleMailTool(
    fakeReq("POST", { token: "t1", args: { account: deadId, to: "x@evil.com", subject: "x", text: "y" } }),
    res,
    new URL("http://127.0.0.1:7864/api/mail/tool/mail_send"),
    { publicReq: false, byToken: () => ({ id: "s1" }), confirm: async () => ({ ok: true }) },
  );
  check("白名单只拦 AI", out.body?.code === "recipients", String(out.body?.code));
}
r = await call("POST", "/api/mail/send", { account: deadId, to: "x@evil.com", subject: "x", text: "y" });
check("页面发给名单外的人不被拦（它自己去连、连不上）", r.body?.code !== "recipients" && r.status === 400, `${r.status} ${r.body?.code}`);
await call("POST", "/api/mail/policy", { recipients: [] });

mc.appendAudit({ t: Date.now(), account: "m1", from: "a@163.com", to: ["b@x.com"], subject: "手发", by: "page", ok: true });
check("日上限只数 AI 发的（页面自己发的不算）", mc.sentToday("m1") === 1 && mc.sentToday("m1", Date.now(), "page") === 1, `${mc.sentToday("m1")}/${mc.sentToday("m1", Date.now(), "page")}`);
// 草稿写在同一个审计文件里，但它没发出去：不能占日上限（B8 的延伸）。
mc.appendAudit({ t: Date.now(), account: "m1", from: "a@163.com", to: ["b@x.com"], subject: "草稿", by: "agent", tool: "mail_draft", ok: true, messageId: "draft" });
check("草稿不占 AI 的日上限", mc.sentToday("m1") === 1, String(mc.sentToday("m1")));

// mail_image 走「读邮件」权限；缺 uid 在连 IMAP 之前就回 bad-input，不碰网络。
{
  const { res, out } = fakeRes();
  await mail.handleMailTool(
    fakeReq("POST", { token: "t1", args: { account: deadId } }),
    res,
    new URL("http://127.0.0.1:7864/api/mail/tool/mail_image"),
    { publicReq: false, byToken: () => ({ id: "s1" }), confirm: async () => ({ ok: true }) },
  );
  check("mail_image 缺 uid → bad-input", out.body?.code === "bad-input", String(out.body?.code));
}

// ---------------------------------------------------------------- 删账号要清掉白名单里的 id
await call("POST", "/api/mail/policy", { accountIds: [deadId] });
r = await call("DELETE", `/api/mail/accounts/${deadId}`);
check("删掉第二个账号", r.status === 200, String(r.status));
r = await call("GET", "/api/mail/config");
check("删账号顺手把它从「AI 能用哪些账号」里去掉", Array.isArray(r.body?.policy?.accountIds) && r.body.policy.accountIds.length === 0, JSON.stringify(r.body?.policy?.accountIds));

// ---------------------------------------------------------------- 默认账号给个能用的
r = await call("POST", "/api/mail/accounts", { id: accId, address: "me@163.com", preset: "163", secret: "abcdefghijklmnop", enabled: false });
check("停用默认账号", r.status === 200, `${r.status} ${r.body?.code ?? ""}`);
// 停用的账号连人也不给用：以前页面口只 findAccount、不看 enabled，CHANGELOG 那句「页面只受账号停用限制」不成立。
r = await call("GET", `/api/mail/message?account=${accId}&folder=INBOX`);
check("停用的账号页面也读不了（409 account-disabled）", r.status === 409 && r.body?.code === "account-disabled", `${r.status} ${r.body?.code}`);
{
  const { res, out } = fakeRes();
  await mail.handleMailTool(fakeReq("POST", { token: "t1", args: {} }), res, new URL("http://127.0.0.1:7864/api/mail/tool/mail_accounts"), {
    publicReq: false,
    byToken: () => ({ id: "s1" }),
    confirm: async () => ({ ok: true }),
  });
  check("默认账号停了就不报它（返回 null 而不是一个必定被拒的 id）", out.body?.defaultAccount === null, JSON.stringify(out.body?.defaultAccount));
  // B21：v1 没有任何「改邮箱状态」的动作，面板也不给那个开关，别向模型报一个不存在的权限。
  check("mail_accounts 不再把 mutate 报给模型", !("mutate" in (out.body?.policy ?? {})), JSON.stringify(Object.keys(out.body?.policy ?? {})));
}
await call("POST", "/api/mail/accounts", { id: accId, address: "me@163.com", preset: "163", secret: "abcdefghijklmnop", enabled: true });

r = await call("DELETE", `/api/mail/accounts/${accId}`);
check("删账号 200", r.status === 200 && r.body?.ok === true, String(r.status));
r = await call("DELETE", `/api/mail/accounts/${accId}`);
check("删不存在的 404", r.status === 404, String(r.status));

// 工具口：token 不对直接 403，且不读配置。
{
  const { res, out } = fakeRes();
  const handled = await mail.handleMailTool(
    fakeReq("POST", { token: "nope", args: {} }),
    res,
    new URL("http://127.0.0.1:7864/api/mail/tool/mail_accounts"),
    { publicReq: false, byToken: () => null, confirm: async () => ({ ok: true }) },
  );
  check("工具口 token 不对 403", handled === true && out.status === 403, `${out.status} ${out.body?.code}`);
}
{
  const { res, out } = fakeRes();
  const handled = await mail.handleMailTool(
    fakeReq("POST", { token: "t1", args: {} }),
    res,
    new URL("http://127.0.0.1:7864/api/mail/tool/mail_accounts"),
    { publicReq: false, byToken: () => ({ id: "s1" }), confirm: async () => ({ ok: true }) },
  );
  check("工具口 mail_accounts 有回包", handled === true && out.body?.ok === true, JSON.stringify(out.body).slice(0, 120));
  check("工具回包不含授权码", !JSON.stringify(out.body ?? {}).includes("abcdefghijklmnop"));
}

// ---------------------------------------------------------------- 配置文件读坏了不许盖掉（D264）
{
  const file = mc.mailConfigFile();
  const good = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, '{"version":1,"accounts":[{"id":"m1","address":"me@163.com","secret":"REALSECRET123456"');
  r = await call("GET", "/api/mail/config");
  check("读坏了要报出来（不是默默当没有账号）", typeof r.body?.configError === "string" && r.body.configError.length > 0, JSON.stringify(r.body?.configError));
  check("横幅能指路到文件", typeof r.body?.configPath === "string" && r.body.configPath.length > 0);
  r = await call("POST", "/api/mail/policy", { read: true });
  check("写操作被拒（409 config-corrupt）", r.status === 409 && r.body?.code === "config-corrupt", `${r.status} ${r.body?.code}`);
  check("磁盘上那份原封不动（授权码还在）", fs.readFileSync(file, "utf8").includes("REALSECRET123456"));
  r = await call("POST", "/api/mail/repair");
  check("repair 也不许盖", r.status === 409 && r.body?.code === "config-corrupt", `${r.status} ${r.body?.code}`);
  fs.writeFileSync(file, good);
  r = await call("GET", "/api/mail/config");
  check("修回去就恢复正常", !r.body?.configError && Array.isArray(r.body?.accounts));
}

// ---------------------------------------------------------------- 收尾

fs.rmSync(tmp, { recursive: true, force: true });
const bad = results.filter((x) => !x.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed`);
if (bad.length) {
  console.log("failed:\n" + bad.map((b) => `  - ${b.name}`).join("\n"));
  process.exit(1);
}
