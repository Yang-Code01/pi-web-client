/**
 * #486：正文改成存净化过的 HTML 之后，标题兜底不能把标签当成标题。
 *
 * 只测纯函数 `titleFromBody`：`saveNote` 会写状态目录里的 notes.json，那属于桥的 e2e，
 * 这里只想钉住「HTML 正文 → 能看的标题」这一条。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { titleFromBody } from "../src/notes.ts";

test("纯文本正文：取第一行前 60 个字", () => {
  assert.equal(titleFromBody("点开设置就白屏\n第二行不要"), "点开设置就白屏 第二行不要");
  assert.equal(titleFromBody("   \n\n  "), "");
});

test("HTML 正文：剥标签、剥实体，只留可读的字", () => {
  const html = "<h1>字号 125% 时底栏被推出屏幕</h1><p>复现：Ctrl+= 按两次，然后看底栏 <b>不见了</b>。</p>";
  assert.equal(titleFromBody(html), "字号 125% 时底栏被推出屏幕 复现：Ctrl+= 按两次，然后看底栏 不见了 。");
});

test("HTML 正文：script / style 里的东西不进标题", () => {
  assert.equal(titleFromBody("<style>.a{color:red}</style><p>真正的标题</p>"), "真正的标题");
  assert.equal(titleFromBody("<script>alert(1)</script>标题"), "标题");
});

test("实体先还原再截断，不把 &amp; 当成 5 个字", () => {
  assert.equal(titleFromBody("<p>a &amp; b</p>"), "a & b");
  assert.equal(titleFromBody("<p>&lt;13:45:02&gt;</p>"), "<13:45:02>");
});

test("长正文截到 60 字，不留半截标签", () => {
  const long = `<p>${"字".repeat(100)}</p>`;
  const title = titleFromBody(long);
  assert.equal(title.length, 60);
  assert.ok(!title.includes("<"));
});
