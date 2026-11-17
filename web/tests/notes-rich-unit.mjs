/**
 * #486 富文本正文：净化白名单、纯文本、老数据回填、``` 触发。
 *
 * 这一层是这个面板唯一「不能靠手点验收」的地方：body 里是我们自己的 contenteditable 产生的
 * HTML，但它也会经过剪贴板、经过 disk 上的老文件、经过别人的 hand-editing。
 *
 *   node --experimental-strip-types web/tests/notes-rich-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  fenceLanguage,
  hasRichMarkup,
  isRichEmpty,
  plainText,
  richToMarkdown,
  sanitizeRich,
  textToRich,
} from "../src/notes/rich.ts";

// ---------------------------------------------------------------- 净化

test("白名单里的结构活着出来", () => {
  const html = "<p>段落</p><ul><li>一</li><li>二</li></ul><pre><code>npm test\n</code></pre><hr><blockquote>引</blockquote>";
  assert.equal(
    sanitizeRich(html),
    "<p>段落</p><ul><li>一</li><li>二</li></ul><pre><code>npm test\n</code></pre><hr><blockquote>引</blockquote>",
  );
});

test("script / iframe / style 连内容一起扔掉", () => {
  assert.equal(sanitizeRich('<p>a</p><script>alert(1)</script><iframe src="x">y</iframe><style>p{}</style>'), "<p>a</p>");
});

test("事件属性、class、id 都不留，但标签本身还在", () => {
  assert.equal(sanitizeRich('<p class="x" id="y" onclick="bad()">点</p>'), "<p>点</p>");
});

test("span 只留颜色 / 底色 / em 字号，别的 style 丢掉", () => {
  assert.equal(
    sanitizeRich('<span style="color: #ff0000; background-color: rgb(255, 235, 59); font-size: 1.4em; position: fixed">红</span>'),
    '<span style="color: #ff0000; background-color: rgb(255, 235, 59); font-size: 1.4em">红</span>',
  );
  assert.equal(sanitizeRich('<span style="position: absolute; z-index: 9">没用的样式</span>'), "没用的样式");
});

test("字号只认 em：px 会让整块跟界面缩放打架", () => {
  assert.equal(sanitizeRich('<span style="font-size: 18px">大</span>'), "大");
  assert.equal(sanitizeRich('<span style="font-size: 1.2em">大</span>'), '<span style="font-size: 1.2em">大</span>');
});

test("url() / expression 这类能带外链的样式值直接丢", () => {
  assert.equal(sanitizeRich('<span style="color: url(https://evil.test/x)">a</span>'), "a");
  assert.equal(sanitizeRich('<span style="background-color: expression(alert(1))">a</span>'), "a");
});

test("链接只留 http(s)，javascript: 变成纯文字", () => {
  assert.equal(sanitizeRich('<a href="https://ok.test">ok</a>'), '<a href="https://ok.test">ok</a>');
  assert.equal(sanitizeRich('<a href="javascript:alert(1)">bad</a>'), "bad");
});

test("没闭合的标签补上，多的闭合标签忽略", () => {
  assert.equal(sanitizeRich("<p><strong>粗"), "<p><strong>粗</strong></p>");
  assert.equal(sanitizeRich("</p><p>a</p>"), "<p>a</p>");
});

test("实体解码后再转义一次，不会越滚越多", () => {
  const once = sanitizeRich("<p>a &amp; b &lt; c</p>");
  assert.equal(once, "<p>a &amp; b &lt; c</p>");
  assert.equal(sanitizeRich(once), once);
});

test("表格结构留着", () => {
  const html = "<table><tbody><tr><th>列</th><td>值</td></tr></tbody></table>";
  assert.equal(sanitizeRich(html), html);
});

// ---------------------------------------------------------------- 纯文本

test("plainText 每个块一行，表格格子用空格隔开", () => {
  assert.equal(plainText("<p>一</p><p>二</p>"), "一\n二");
  assert.equal(plainText("<p>a<br>b</p>"), "a\nb");
  assert.equal(plainText("<ul><li>x</li><li>y</li></ul>"), "x\ny");
  assert.equal(plainText("<table><tr><td>a</td><td>b</td></tr></table>"), "a b");
  assert.equal(plainText("<pre><code>a\nb</code></pre>"), "a\nb");
});

test("plainText 把 &nbsp; 收成普通空格，行尾空白去掉", () => {
  assert.equal(plainText("<p>a&nbsp;&nbsp;b&nbsp;</p>"), "a  b");
});

test("isRichEmpty：空白、&nbsp;、空段落都算空", () => {
  assert.equal(isRichEmpty(""), true);
  assert.equal(isRichEmpty("<p><br></p>"), true);
  assert.equal(isRichEmpty("<p>&nbsp;</p>"), true);
  assert.equal(isRichEmpty("<p>&nbsp;</p><hr>"), false);
  assert.equal(isRichEmpty("<p>字</p>"), false);
});

// ---------------------------------------------------------------- 老数据 / 回填

test("hasRichMarkup：只有真正的块标签才算富文本", () => {
  assert.equal(hasRichMarkup("<p>a</p>"), true);
  assert.equal(hasRichMarkup("<strong>a</strong>"), false);
  assert.equal(hasRichMarkup("用的是 <pre> 标签"), true);
  assert.equal(hasRichMarkup("时间 <13:45:02> 报错"), false);
  assert.equal(hasRichMarkup("金额 a < b"), false);
});

test("纯文本回填成段落，换行不丢，HTML 特殊字符被转义", () => {
  assert.equal(textToRich("第一行\n第二行 <b>不是粗体</b>"), "<p>第一行</p><p>第二行 &lt;b&gt;不是粗体&lt;/b&gt;</p>");
  assert.equal(textToRich(""), "");
  assert.equal(textToRich("a\n\nb"), "<p>a</p><p>b</p>");
});

test("回填幂等：富文本再回填一次不变", () => {
  const rich = "<p>a</p><ul><li>b</li></ul>";
  assert.equal(textToRich(rich), rich);
});

test("escapeHtml 只转义该转的", () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
});

// ---------------------------------------------------------------- ``` 触发

test("三个反引号换成代码块，带语言也认", () => {
  assert.equal(fenceLanguage("```"), "");
  assert.equal(fenceLanguage("  ```  "), "");
  assert.equal(fenceLanguage("```ts"), "ts");
  assert.equal(fenceLanguage("```c++"), "c++");
});

test("不是整行就三个反引号的不触发", () => {
  assert.equal(fenceLanguage("看 ``` 这个"), null);
  assert.equal(fenceLanguage("``"), null);
  assert.equal(fenceLanguage("``` 多余的空格"), null);
});

// ---------------------------------------------------------------- Markdown 导出

test("导出 Markdown：标题、列表、代码块、分隔线、表格", () => {
  const html =
    "<h2>标题</h2><p>正文 <strong>粗</strong> <em>斜</em> <code>x()</code></p>" +
    "<ul><li>一</li><li>二</li></ul><pre><code>npm test\n</code></pre><hr>" +
    "<table><tr><th>列</th></tr><tr><td>值</td></tr></table>";
  const md = richToMarkdown(html);
  assert.match(md, /## 标题/);
  assert.match(md, /正文 \*\*粗\*\* \*斜\* `x\(\)`/);
  assert.match(md, /- 一\n- 二/);
  assert.match(md, /```\nnpm test\n```/);
  assert.match(md, /\n---\n/);
  assert.match(md, /\| 列 \|\n\| --- \|\n\| 值 \|/);
});

test("导出 Markdown：删除线、下划线、链接、引用", () => {
  const md = richToMarkdown('<p><s>删</s> <u>下</u> <a href="https://x.test">链</a></p><blockquote><p>引</p></blockquote>');
  assert.match(md, /~~删~~/);
  assert.match(md, /<u>下<\/u>/);
  assert.match(md, /\[链\]\(https:\/\/x\.test\)/);
  assert.match(md, /> 引/);
});
