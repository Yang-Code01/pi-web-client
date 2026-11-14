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

r = await call("POST", "/api/mail/accounts", { address: "me@163.com", preset: "163", secret: "abcdefghijklmnop", label: "工作" });
check("加账号 200", r.status === 200 && r.body?.ok === true, String(r.status));
check("加账号只回掩码", !JSON.stringify(r.body).includes("abcdefghijklmnop"), JSON.stringify(r.body?.account));
const accId = r.body?.account?.id;

r = await call("POST", "/api/mail/accounts", { address: "me@163.com", preset: "163", secret: "abcdefghijklmnop" });
check("重复地址 400 duplicate", r.status === 400 && r.body?.code === "duplicate", `${r.status} ${r.body?.code}`);

r = await call("POST", "/api/mail/policy", { send: false });
check("改权限 200", r.status === 200 && r.body?.policy?.send === false, JSON.stringify(r.body?.policy));
r = await call("GET", "/api/mail/config");
check("改完读回来是新的", r.body?.policy?.send === false);

r = await call("POST", "/api/mail/policy", { read: false });
check("关掉读权限 200", r.body?.policy?.read === false);
r = await call("GET", "/api/mail/folders");
check("读权限关着时不连邮箱、回 policy-denied", r.status === 403 && String(r.body?.code).startsWith("policy-denied"), `${r.status} ${r.body?.code} ${r.body?.error}`);
await call("POST", "/api/mail/policy", { read: true });

r = await call("GET", "/api/mail/config", undefined, { publicReq: true });
check("隧道访客 403", r.status === 403 && r.body?.code === "tunnel_readonly", String(r.body?.code));

r = await call("GET", "/api/mail/nope");
check("未知路径也认领（不回落到别的路由）", r.handled === true);

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

// ---------------------------------------------------------------- 收尾

fs.rmSync(tmp, { recursive: true, force: true });
const bad = results.filter((x) => !x.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed`);
if (bad.length) {
  console.log("failed:\n" + bad.map((b) => `  - ${b.name}`).join("\n"));
  process.exit(1);
}
