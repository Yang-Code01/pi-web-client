/**
 * Unit: 邮箱的「取数口径」与「地址口径」—— 都是纯函数，不碰网络。
 *
 * 这两块正是用户报障的那两处（D264）：
 *   1. 列表以前按「序号最后 N 条」取，而序号是「进文件夹的先后」不是邮件时间 —— 从备份恢复 /
 *      从别处搬回来过的信箱里两者是错位的，于是默认 20 封里混着一年前的信、新信反而看不到；
 *      未读又是在那个窗口里本地过滤的，窗口外的未读永远不出现。
 *   2. 面板「回复」把 `Name <a@b.com>` 整串当收件人喂给地址正则，带显示名的发件人一律 500。
 *
 *   node --experimental-strip-types bridge/tests/mail-list-unit.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const t = await import("../src/mailtransport.ts");
const addr = await import("../src/mailaddr.ts");
const mail = await import("../src/mail.ts");
const ext = await import("../ext/mail.ts");

// ---------------------------------------------------------------- 序号窗口

check("500 封里取最近 200：只切一段", JSON.stringify(t.seqWindows(500, 200, 200)) === JSON.stringify([{ start: 301, end: 500 }]));
check(
  "预算比一段小：从最后一封往回数",
  JSON.stringify(t.seqWindows(450, 300, 200)) === JSON.stringify([
    { start: 251, end: 450 },
    { start: 151, end: 250 },
  ]),
  JSON.stringify(t.seqWindows(450, 300, 200)),
);
check("信箱比预算小：一段就到底", JSON.stringify(t.seqWindows(37, 2000, 200)) === JSON.stringify([{ start: 1, end: 37 }]));
check("空信箱没有窗口", t.seqWindows(0, 2000, 200).length === 0);
check("预算 0 不会死循环", t.seqWindows(100, 0, 200).length === 0);

// ---------------------------------------------------------------- 按时间挑

// 真实的错位形状（用户那台 QQ 邮箱）：序号大的那批反而更老。
const rows = [
  { uid: 1412, date: Date.parse("2022-01-31T11:10:00Z") },
  { uid: 1429, date: Date.parse("2021-09-30T12:34:00Z") },
  { uid: 1392, date: Date.parse("2022-03-25T01:42:00Z") },
  { uid: 1330, date: Date.parse("2022-01-01T14:49:00Z") },
];
const sorted = t.orderByDateDesc(rows);
check("按时间倒序，最新的排第一", sorted[0].uid === 1392, String(sorted[0].uid));
check("再取最近 2 封 = 2022-03 / 2022-01", JSON.stringify(sorted.slice(0, 2).map((r) => r.uid)) === "[1392,1412]");
check("拿不到时间的排最后", t.orderByDateDesc([{ uid: 1, date: 0 }, { uid: 2, date: 5 }])[1].uid === 1);
check("排序不改原数组", rows[0].uid === 1412);

// ---------------------------------------------------------------- 翻页

check("offset=0 取 2 封", JSON.stringify(t.takeWindow(sorted, 2, 0).map((r) => r.uid)) === "[1392,1412]");
check("offset=2 接着往后", JSON.stringify(t.takeWindow(sorted, 2, 2).map((r) => r.uid)) === "[1330,1429]");
check("offset 超出范围 = 空", t.takeWindow(sorted, 10, 99).length === 0);
check("limit 至少给一封", t.takeWindow(sorted, 0, 0).length === 1);

// ---------------------------------------------------------------- 地址

check("裸地址原样", addr.bareAddress("a@b.com") === "a@b.com");
check("带显示名剥出地址", addr.bareAddress("PlayStation <email@email.playstation.com>") === "email@email.playstation.com");
check("带引号的显示名也能剥", addr.bareAddress('"Doe, John" <j@x.com>') === "j@x.com");
check("尖括号空着 = 没有地址", addr.bareAddress("Nobody <>") === "");
check("显示名取出来", addr.displayName("PlayStation <email@x.com>") === "PlayStation");
check("裸地址没有显示名", addr.displayName("a@b.com") === "");
check("带显示名的收件人算合法", addr.isEmailAddress("PlayStation <email@email.playstation.com>"));
check("不像地址的不算", !addr.isEmailAddress("nope") && !addr.isEmailAddress("a@b") && !addr.isEmailAddress(""));
check("去重不分大小写", JSON.stringify(addr.bareAddresses(["A@B.com", "a@b.com", "C@d.com"])) === '["A@B.com","C@d.com"]');

check(
  "收件人串：引号 / 尖括号里的逗号不切",
  JSON.stringify(t.splitRecipients('"Doe, John" <j@x.com>, a@y.com')) === '["\\"Doe, John\\" <j@x.com>","a@y.com"]',
  JSON.stringify(t.splitRecipients('"Doe, John" <j@x.com>, a@y.com')),
);
check("分号 / 换行 / 中文逗号都算分隔", t.splitRecipients("a@x.com；b@y.com，c@z.com\nd@w.com").length === 4);

// ---------------------------------------------------------------- 发信参数

const okMail = mail.normalizeMail({ to: "PlayStation <email@email.playstation.com>", subject: "Re: hi", text: "好的" });
check("带显示名的收件人不再被拦", okMail.to[0] === "PlayStation <email@email.playstation.com>");
check("显示名保留在 To 头里", okMail.to[0].includes("<email@email.playstation.com>"));
{
  let code = "";
  try {
    mail.normalizeMail({ to: "nope", subject: "x", text: "y" });
  } catch (err) {
    code = err.code;
  }
  // 以前这里抛 smtp-error，路由按 500 回；参数错就该是 400。
  check("不像地址 → bad-input（不是 500 的 smtp-error）", code === "bad-input", code);
}
{
  let code = "";
  try {
    mail.normalizeMail({ to: "a@b.com", subject: "x", text: "  " });
  } catch (err) {
    code = err.code;
  }
  check("空正文 → bad-input", code === "bad-input", code);
}
{
  let code = "";
  try {
    mail.normalizeMail({ to: "a@b.com", subject: "x", text: "y", attachments: ["/no/such/file.pdf"] });
  } catch (err) {
    code = err.code;
  }
  check("附件不存在 → not-found", code === "not-found", code);
}
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mail-att-"));
  const file = path.join(tmp, "报告.txt");
  fs.writeFileSync(file, "hi");
  const got = mail.normalizeAttachments([file]);
  check("附件带上文件名", got.length === 1 && got[0].filename === "报告.txt", JSON.stringify(got));
  check("回复路径也认同一个附件口径", mail.normalizeAttachments([{ path: file }])[0].filename === "报告.txt");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 纯 HTML 正文

check(
  "HTML 扒标签",
  ext.htmlToText("<p>你好</p><p>第二段</p>").includes("你好") && ext.htmlToText("<p>你好</p><p>第二段</p>").includes("第二段"),
  JSON.stringify(ext.htmlToText("<p>你好</p><p>第二段</p>")),
);
check("script / style 整段丢掉", !ext.htmlToText("<style>a{}</style><script>x()</script><div>正文</div>").includes("x()"));
check("带属性的 style 也不漏 CSS", !ext.htmlToText('<style type="text/css">.x{color:red}</style><div>正文</div>').includes(".x{"));
check("实体还原", ext.htmlToText("<div>a &amp; b &lt;c&gt;</div>").includes("a & b <c>"));
check("图片不静默消失：保留 alt", ext.htmlToText('<p>看图</p><img src="x" alt="报价单">').includes("[图片：报价单]"));
check("图片没有 alt 也留标记", ext.htmlToText('<img src="x">').includes("[图片]"));

// ---------------------------------------------------------------- 内嵌图片（cid）

const inlineRaw = Buffer.from(
  [
    'From: "Alice" <alice@example.com>',
    "To: bob@example.com",
    "Subject: inline",
    "MIME-Version: 1.0",
    'Content-Type: multipart/related; boundary="rel"',
    "",
    "--rel",
    'Content-Type: text/html; charset=utf-8',
    "",
    '<html><body><p>hi</p><img src="cid:logo@x" alt="logo"></body></html>',
    "--rel",
    'Content-Type: image/png; name="logo.png"',
    "Content-Transfer-Encoding: base64",
    "Content-ID: <logo@x>",
    'Content-Disposition: inline; filename="logo.png"',
    "",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==",
    "--rel--",
    "",
  ].join("\n"),
);
const cidDetail = await t.parseMailSource(inlineRaw, 7, { keepCidLinks: true });
check("内嵌图片有 cid、标成 inline", cidDetail.attachments.length === 1 && cidDetail.attachments[0].contentId === "logo@x" && cidDetail.attachments[0].inline === true, JSON.stringify(cidDetail.attachments));
check("工具口保留 cid:，不把 base64 塞进正文", cidDetail.html?.includes("cid:logo@x") === true && !cidDetail.html?.includes("data:image"));
const richDetail = await t.parseMailSource(inlineRaw, 7);
check("面板口换 data URI，图片不用再拉一遍 IMAP", richDetail.html?.includes("data:image/png;base64") === true && !richDetail.html?.includes("cid:logo@x"));
check("没有 Content-Disposition 的 image/* + Content-ID 也算内嵌", t.isInlineAttachment({ contentId: "<x@y>", contentType: "image/png" }));
check("普通附件不算内嵌", !t.isInlineAttachment({ filename: "a.pdf", contentType: "application/pdf" }));

// 工具口 20,000 字截断前先去掉 head/style，否则营销邮件前 20k 全是 CSS，正文被切没。
const compacted = mail.htmlForModel('<html><head><style type="text/css">body{color:red}</style></head><body><p>正文</p><img src="cid:x"></body></html>');
check("工具口先去掉 head/style 再截断", !compacted.includes("color:red") && compacted.includes("<p>正文</p>") && compacted.includes("cid:x"), compacted.slice(0, 120));

// ---------------------------------------------------------------- 收尾

const bad = results.filter((x) => !x.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed`);
if (bad.length) {
  console.log("failed:\n" + bad.map((b) => `  - ${b.name}`).join("\n"));
  process.exit(1);
}
