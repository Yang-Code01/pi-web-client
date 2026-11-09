/**
 * Jira 面板的纯函数（#248、#249、#250、#252）：站点地址判定、token 掩码、工单行链接与元信息、
 * ADF → 纯文本、字节大小格式化、交给 agent 的提示词。
 *
 * 只测这几层；dialog 的交互（Esc、焦点、错误态按钮、缓存、展开）不启浏览器，靠肉眼与桥端 e2e 探针。
 * 站点地址的正负例必须与 `bridge/src/jira.ts` 的 `siteUrlProblem` 一一对应 —— 那边是权威。
 *
 * Run: node web/tests/jira-unit.mjs
 * （纯函数在 `web/src/jira-shared.ts`，不 import `chat.ts`；Node 22 要加
 * `--experimental-transform-types`，Node 26 起类型剥离默认开启。）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { adfToText, browseUrl, downloadMark, formatBytes, formatUpdated, handoffPrompt, issueMeta, keyMask, siteUrlProblem } from "../src/jira-shared.ts";

const bad = (raw) => {
  const problem = siteUrlProblem(raw);
  assert.ok(problem, `${JSON.stringify(raw)} 应该被拒绝`);
  return problem;
};

test("只收 https", () => {
  bad("http://acme.atlassian.net");
  assert.equal(siteUrlProblem("https://acme.atlassian.net"), null);
});

test("IP 字面量被拒（v4 与 v6）", () => {
  bad("https://10.0.0.5");
  bad("https://192.168.1.20:8443");
  bad("https://[::1]");
});

test("localhost 与内网域名被拒", () => {
  bad("https://localhost");
  bad("localhost:8080");
  bad("https://jira.local");
  bad("https://jira.internal");
});

test("带路径 / 查询 / 片段被拒", () => {
  bad("https://acme.atlassian.net/jira/software");
  bad("https://acme.atlassian.net/?x=1");
  bad("https://acme.atlassian.net/#top");
});

test("正常 Cloud 站点通过，结尾 / 与省略 scheme 都能接受", () => {
  assert.equal(siteUrlProblem("https://acme.atlassian.net"), null);
  assert.equal(siteUrlProblem("https://acme.atlassian.net/"), null);
  assert.equal(siteUrlProblem("  acme.atlassian.net  "), null);
  assert.equal(siteUrlProblem("acme.atlassian.net/"), null);
});

test("空地址要一句人话，不是 null", () => {
  assert.ok(siteUrlProblem(""));
  assert.ok(siteUrlProblem("   "));
});

test("掩码只露后 4 位，短的整串掩掉", () => {
  assert.equal(keyMask("ATATT3xFfGF0abcd"), "••••abcd");
  assert.equal(keyMask("abcd"), "••••");
  assert.equal(keyMask("abc"), "••••");
  assert.equal(keyMask(""), "••••");
});

test("工单 / 项目链接：去掉站点结尾 /，key 做 URL 编码", () => {
  assert.equal(browseUrl("https://acme.atlassian.net", "ACME-12"), "https://acme.atlassian.net/browse/ACME-12");
  assert.equal(browseUrl("https://acme.atlassian.net/", "ACME-12"), "https://acme.atlassian.net/browse/ACME-12");
  assert.equal(browseUrl("  https://acme.atlassian.net//  ", "OPS"), "https://acme.atlassian.net/browse/OPS");
  assert.equal(browseUrl("https://acme.atlassian.net", "A B"), "https://acme.atlassian.net/browse/A%20B");
});

test("更新时间按本地时区格式化，解不出时间给空串", () => {
  assert.equal(formatUpdated("2026-11-08T09:30:00.000+0000"), formatUpdated("2026-11-08T09:30:00.000Z"));
  assert.match(formatUpdated("2026-11-08T09:30:00.000Z"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatUpdated(""), "");
  assert.equal(formatUpdated("not a date"), "");
});

const issue = { key: "ACME-9", summary: "x", type: "Task", priority: null, status: "To Do", updated: "2026-11-05T14:02:11.000Z" };

test("工单元信息：用 · 连类型 / 优先级 / 状态 / 时间，空优先级显示 —", () => {
  const meta = issueMeta(issue);
  assert.ok(meta.startsWith("Task · — · To Do · "), meta);
  assert.equal(meta.split(" · ").length, 4);
  assert.ok(!issueMeta({ ...issue, updated: "" }).includes("·  "), "时间空时不留下多余的 ·");
  assert.equal(issueMeta({ ...issue, type: "", priority: "", status: "", updated: "" }), "—");
});

// ---------------------------------------------------------------- #250 ADF → 纯文本

const doc = (...content) => ({ type: "doc", version: 1, content });

test("ADF：段落与标题按阅读顺序，标题带 #", () => {
  const text = adfToText(
    doc(
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "背景" }] },
      { type: "paragraph", content: [{ type: "text", text: "第一段。" }] },
    ),
  );
  assert.equal(text, "## 背景\n第一段。");
});

test("ADF：无序 / 有序列表，嵌套缩进", () => {
  const bullet = doc({
    type: "bulletList",
    content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "一" }] }] },
      {
        type: "listItem",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "二" }] },
          {
            type: "bulletList",
            content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "二之一" }] }] }],
          },
        ],
      },
    ],
  });
  assert.equal(adfToText(bullet), "• 一\n• 二\n  • 二之一");

  const ordered = doc({
    type: "orderedList",
    content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "先装依赖" }] }] },
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "再跑测试" }] }] },
    ],
  });
  assert.equal(adfToText(ordered), "1. 先装依赖\n2. 再跑测试");
});

test("ADF：代码块保留换行并加围栏", () => {
  const text = adfToText(
    doc({ type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const a = 1;\nconst b = 2;" }] }),
  );
  assert.equal(text, "```\nconst a = 1;\nconst b = 2;\n```");
});

test("ADF：表格一行一条，单元格用 | 分隔", () => {
  const cell = (text) => ({ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  const text = adfToText(
    doc({
      type: "table",
      content: [
        { type: "tableRow", content: [cell("名称"), cell("大小")] },
        { type: "tableRow", content: [cell("spec.pdf"), cell("2 KB")] },
      ],
    }),
  );
  assert.equal(text, "名称 | 大小\nspec.pdf | 2 KB");
});

test("ADF：media 节点出占位文本，图片与普通附件分开", () => {
  const text = adfToText(
    doc(
      { type: "paragraph", content: [{ type: "text", text: "看图：" }] },
      { type: "mediaSingle", content: [{ type: "media", attrs: { id: "m-1", type: "image", alt: "a.png" } }] },
      { type: "media", attrs: { id: "m-2", type: "file" } },
    ),
  );
  assert.equal(text, "看图：\n[图片]\n[附件]");
});

test("ADF：mention、hardBreak 与链接标记", () => {
  const text = adfToText(
    doc({
      type: "paragraph",
      content: [
        { type: "mention", attrs: { text: "Ada" } },
        { type: "text", text: " 看 " },
        { type: "text", text: "文档", marks: [{ type: "link", attrs: { href: "https://x.test/doc" } }] },
        { type: "hardBreak" },
        { type: "text", text: "下一行" },
      ],
    }),
  );
  assert.equal(text, "@Ada 看 文档 (https://x.test/doc)\n下一行");
});

test("ADF：空 / 非 ADF 输入给空串，字符串原样", () => {
  assert.equal(adfToText(null), "");
  assert.equal(adfToText(undefined), "");
  assert.equal(adfToText({}), "");
  assert.equal(adfToText("纯文本"), "纯文本");
  assert.equal(adfToText(doc()), "");
});

// ---------------------------------------------------------------- #250 大小

test("formatBytes：B / KB / MB 进位，未知显示 —", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5 MB");
  assert.equal(formatBytes(null), "—");
  assert.equal(formatBytes(undefined), "—");
  assert.equal(formatBytes(Number.NaN), "—");
  assert.equal(formatBytes(-1), "—");
});

// ---------------------------------------------------------------- #251 下载结果

test("downloadMark：对勾只给真落盘的那项", () => {
  assert.equal(downloadMark("saved"), "✓");
  assert.equal(downloadMark("skipped"), "·");
  assert.equal(downloadMark("failed"), "✗");
});

// ---------------------------------------------------------------- #252 交给 agent

const handoff = {
  key: "ACME-12",
  summary: "登录页偶发 500",
  siteUrl: "https://acme.atlassian.net/",
  status: "待办",
  priority: "高",
  type: "Bug",
};

test("handoffPrompt：全文逐字，工单信息与固定指令都在", () => {
  assert.equal(
    handoffPrompt(handoff),
    [
      "处理这个 Jira 工单：ACME-12 — 登录页偶发 500",
      "",
      "链接：https://acme.atlassian.net/browse/ACME-12",
      "状态：待办 · 优先级：高 · 类型：Bug",
      "",
      "请用 Jira MCP 工具（如 mcp__atlassian__*）读取这个工单的详细描述和全部评论，正文我没有贴进来。",
      "- 结合代码分析问题原因；如果是 bug，给出具体、可复现的操作步骤。",
      "- 描述或评论里的附件/截图你看不到时，先问我是我自己下载，还是已经下好了、路径在哪。",
      "",
      "如果你的工具里没有可用的 Jira，先直接告诉我，不要猜内容。需要我确认的地方先问，不要直接改代码。",
    ].join("\n"),
  );
});

test("handoffPrompt：下载过才有附件行，路径以结尾斜杠收尾", () => {
  const withDir = handoffPrompt({ ...handoff, dir: "C:\\Users\\me\\jira\\ACME-12" });
  assert.ok(withDir.includes("- 已经下载到本机的附件在：C:\\Users\\me\\jira\\ACME-12\\\n\n如果你的工具里"));
  // 已经带结尾斜杠（Windows 或 POSIX）不重复加。
  assert.ok(withDir.includes("ACME-12\\\n"));
  assert.ok(!withDir.includes("ACME-12\\\\\n"));
  assert.ok(handoffPrompt({ ...handoff, dir: "D:/jira/ACME-12/" }).includes("D:/jira/ACME-12/\n"));
  // 没下载过（null / 缺省 / 空白）就没有这一行。
  for (const dir of [null, undefined, "  "]) {
    assert.ok(!handoffPrompt({ ...handoff, dir }).includes("已经下载到本机的附件在"), `dir=${dir}`);
  }
});

test("handoffPrompt：优先级 null 写「未设置」，缺省就省略那一段", () => {
  assert.ok(handoffPrompt({ ...handoff, priority: null }).includes("状态：待办 · 优先级：未设置 · 类型：Bug"));
  assert.ok(handoffPrompt({ ...handoff, priority: undefined }).includes("状态：待办 · 类型：Bug"));
});

test("handoffPrompt：标题为空只留工单号，链接跟着 key", () => {
  const text = handoffPrompt({ ...handoff, summary: "  ", key: "ACME-7" });
  assert.ok(text.startsWith("处理这个 Jira 工单：ACME-7\n\n链接：https://acme.atlassian.net/browse/ACME-7\n"));
});
