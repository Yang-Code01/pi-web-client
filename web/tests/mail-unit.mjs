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
import { auditOutcome, MAIL_ERROR_TEXT, MAIL_POLICY_LABELS, MailConfirmQueue, mailErrorText, parseRecipients, portOf, secureForPort, sizeText, whenText } from "../src/mail-shared.ts";

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

test("自定义服务器：TLS 由端口算，不再靠「字符串里有没有 587」", () => {
  // 隐式 TLS
  for (const port of [993, 465]) {
    assert.equal(secureForPort(port, "imap"), true, `imap ${port}`);
    assert.equal(secureForPort(port, "smtp"), true, `smtp ${port}`);
  }
  // STARTTLS 升级：以前 IMAP 恒 true、SMTP 只认 587 那个字符串，143 / 25 / 110 永远连不上
  for (const port of [143, 25, 110, 587]) {
    assert.equal(secureForPort(port, "imap"), false, `imap ${port}`);
    assert.equal(secureForPort(port, "smtp"), false, `smtp ${port}`);
  }
  // 认不出来的端口：IMAP 默认开、SMTP 默认关（和预设表同一口径）
  assert.equal(secureForPort(1433, "imap"), true);
  assert.equal(secureForPort(1433, "smtp"), false);
  // 995 是 POP3S：本仓库只说 IMAP/SMTP，别顺手认一个用不上的端口
  assert.equal(secureForPort(995, "imap"), true, "认不出来的端口对 IMAP 默认开");
});

test("端口输入框：空 / 非数字 / 越界都回落到预设", () => {
  assert.equal(portOf("993", 465), 993);
  assert.equal(portOf(" 587 ", 465), 587);
  assert.equal(portOf("", 465), 465);
  assert.equal(portOf("   ", 465), 465);
  assert.equal(portOf("abc", 465), 465);
  assert.equal(portOf("0", 465), 465);
  assert.equal(portOf("-1", 465), 465);
  assert.equal(portOf("70000", 465), 465);
});

test("发信确认：一次只问一封，回执只认当前那封", () => {
  const acks = [];
  const queue = new MailConfirmQueue((ack) => acks.push(ack));
  const mail = (subject) => ({ account: "工作", from: "me@qq.com", to: ["a@b.com"], cc: [], subject, text: "hi", attachments: [] });

  queue.push("r1", mail("第一封"));
  queue.push("r2", mail("第二封"));
  assert.equal(queue.current.reqId, "r1", "先来先问");
  assert.equal(queue.size, 2);

  queue.settle(true);
  assert.deepEqual(acks, [{ reqId: "r1", ok: true, reason: undefined, text: undefined }]);
  assert.equal(queue.current.reqId, "r2", "结掉一封自动进下一封");

  // 用户拒掉：回 ok:false + 给人看的一句话，桥那边按 declined 处理
  queue.settle(false, "declined", "你选了不发，这封信没有发出去。");
  assert.equal(acks[1].ok, false);
  assert.equal(acks[1].reason, "declined");
  assert.ok(acks[1].text.includes("没有发"));
  assert.equal(queue.current, null, "队列空了就没有当前那封");

  // 空了再回执什么都不发生（迟到的点击不能凭空造一封）
  queue.settle(true);
  assert.equal(acks.length, 2);
});

test("发信确认：队列变化会通知重画（有当前那封 / 收摊）", () => {
  let paints = 0;
  const queue = new MailConfirmQueue(
    () => {},
    () => {
      paints += 1;
    },
  );
  const mail = { account: "工作", from: "me@qq.com", to: [], cc: [], subject: "x", text: "", attachments: [] };
  assert.equal(paints, 0);
  queue.push("r1", mail);
  assert.equal(paints, 1, "进来一封就该画");
  queue.settle(true);
  assert.equal(paints, 2, "结掉之后要再收一次（队列空了就收摊）");
  queue.push("", mail);
  assert.equal(paints, 2, "空 reqId 不算一条");
});

test("审计里的失败原因：翻译成人话，认不出来的码不往外露", () => {
  // B20：以前直接把 `smtp-error` 这种稳定错误码铺在用户眼前。
  assert.equal(mailErrorText("smtp-error"), "发送失败：服务器拒收");
  assert.equal(mailErrorText(" rate-limited "), "当天发信额度用完了");
  assert.equal(mailErrorText("no-ack"), "确认弹窗没有回音，没发出去");
  // 页面自己 5 分钟没点，和「服务器没回应」不是一回事
  assert.notEqual(mailErrorText("confirm-timeout"), mailErrorText("timeout"));
  // 认不出来的：回空串，调用方显示「失败」，不把码亮出来
  assert.equal(mailErrorText("weird-code-xyz"), "");
  assert.equal(mailErrorText(undefined), "");
  // 表里每一条都得是中文原文（使用处 tr()），否则英文界面会漏成码
  for (const [code, text] of Object.entries(MAIL_ERROR_TEXT)) {
    assert.match(text, /[\u4e00-\u9fa5]/, `${code} 的文案不像中文原文`);
  }
});
