/**
 * 邮箱面板的纯函数（`web/src/mail-shared.ts`）：权限标签表、白名单解析、时间与大小格式化。
 *
 * 只测这几层；dialog 的交互（Esc、焦点、错误态、发送前确认）靠桥端 e2e 与肉眼。
 * 权限键必须与 `bridge/src/mailconfig.ts` 的 `MailPolicy` 一一对应 —— 那边是权威。
 *
 * Run: node --experimental-strip-types web/tests/mail-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { auditOutcome, MAIL_POLICY_LABELS, parseRecipients, sizeText, whenText } from "../src/mail-shared.ts";

test("权限表覆盖六个开关，键与桥端一致", () => {
  assert.deepEqual(
    MAIL_POLICY_LABELS.map((x) => x.key),
    ["read", "send", "draft", "attachments", "mutate", "confirmSend"],
  );
  for (const item of MAIL_POLICY_LABELS) {
    assert.ok(item.label.length > 0, `${item.key} 缺标签`);
    assert.ok(item.hint.length > 0, `${item.key} 缺说明`);
    // 标签是中文原文，使用处 tr(item.label)；这里只保证它确实是要翻译的中文。
    assert.match(item.label, /[\u4e00-\u9fa5]/, `${item.key} 的标签不像中文原文`);
    assert.match(item.hint, /[\u4e00-\u9fa5]/);
  }
});

test("白名单：逗号 / 分号 / 空白 / 换行都算分隔", () => {
  assert.deepEqual(parseRecipients("a@x.com, b@y.com;c@z.com\nd@w.com"), ["a@x.com", "b@y.com", "c@z.com", "d@w.com"]);
  assert.deepEqual(parseRecipients("  @corp.com  "), ["@corp.com"]);
  assert.deepEqual(parseRecipients(""), []);
  assert.deepEqual(parseRecipients("   \n\t "), []);
});

test("时间：今天给 HH:MM，别的日子给日期", () => {
  const now = new Date(2026, 10, 15, 14, 30).getTime();
  const today = new Date(2026, 10, 15, 9, 5).getTime();
  const past = new Date(2026, 2, 7, 23, 59).getTime();
  assert.equal(whenText(today, now), "09:05");
  assert.equal(whenText(past, now), "2026-03-07");
  assert.equal(whenText(0, now), "");
  assert.equal(whenText(Number.NaN, now), "");
});

test("大小：与「设置 → 本机管理」同一口径（空格 + 最多一位小数，`.0` 不写）", () => {
  assert.equal(sizeText(0), "0 B");
  assert.equal(sizeText(-5), "0 B");
  assert.equal(sizeText(512), "512 B");
  assert.equal(sizeText(2048), "2 KB");
  assert.equal(sizeText(1536), "1.5 KB");
  // KB 档不再四舍五入成整数：1.4 KB 以前显示成 1KB，和本机管理里的 1.4 KB 对不上。
  assert.equal(sizeText(1434), "1.4 KB");
  assert.equal(sizeText(1024 * 1024), "1 MB");
  assert.equal(sizeText(1024 * 1024 * 2.5), "2.5 MB");
  assert.equal(sizeText(1024 ** 3 * 3), "3 GB");
});

test("审计结果：存草稿不能显示成「已发出」", () => {
  assert.equal(auditOutcome({ tool: "mail_draft", ok: true, messageId: "draft" }), "draft");
  // 页面自己点「存草稿」走 /api/mail/send + draft:true，桥不传 tool，只有 messageId 能认。
  assert.equal(auditOutcome({ ok: true, messageId: "draft" }), "draft");
  assert.equal(auditOutcome({ tool: "mail_send", ok: true, messageId: "<real@qq.com>" }), "sent");
  assert.equal(auditOutcome({ tool: "mail_send", ok: false }), "failed");
  assert.equal(auditOutcome({ tool: "mail_draft", ok: false, messageId: "draft" }), "failed");
  // 老记录没有 tool、也没有 messageId：只能按 ok 判，别抛错。
  assert.equal(auditOutcome({ ok: true }), "sent");
});
