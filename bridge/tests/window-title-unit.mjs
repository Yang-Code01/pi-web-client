/**
 * D358：桥只在 `PI_WEB_WINDOW_TITLE` 非空时动 index.html；动的是 `<title>` 和注入的全局，
 * 其余字节原样，且标题里的 `</script>` / `<` 不能把页面写坏。
 *
 *   node --experimental-strip-types --test bridge/tests/window-title-unit.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { injectWindowTitle, windowTitleFromEnv } from "../src/window-title.ts";

const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><title>pi</title><link rel="manifest" href="/manifest.webmanifest" /></head><body><div id="app"></div></body></html>`;

test("没设标题时页面一个字节都不变", () => {
  assert.equal(injectWindowTitle(page, ""), page);
  assert.equal(injectWindowTitle(page, "   "), page);
  assert.equal(windowTitleFromEnv({}), "");
});

test("环境变量去掉两边空白；没设就是空串", () => {
  assert.equal(windowTitleFromEnv({ PI_WEB_WINDOW_TITLE: "  测试 t2 " }), "测试 t2");
  assert.equal(windowTitleFromEnv({ PI_WEB_WINDOW_TITLE: "" }), "");
});

test("<title> 直接换掉（首帧 tab 就是对的），全局挂在 </head> 前", () => {
  const out = injectWindowTitle(page, "测试 t1");
  assert.ok(out.includes("<title>测试 t1</title>"), "title 没换掉");
  assert.ok(out.includes('window.__piWindowTitle="测试 t1"'), "全局没注入");
  assert.ok(out.indexOf('window.__piWindowTitle') < out.indexOf("</head>"), "全局没进 head");
  assert.equal(out.replace(/<title>[\s\S]*?<\/title>/, "<title>pi</title>").replace(/<script>[\s\S]*?<\/script>(?=<\/head>)/, ""), page);
});

test("标题里的尖括号与引号不会把标签 / 脚本提前闭合", () => {
  const out = injectWindowTitle(page, `测试 </script><b>&"`);
  assert.ok(out.includes('<title>测试 &lt;/script&gt;&lt;b&gt;&amp;"</title>'), out.split("\n")[0]);
  const scripts = out.match(/<script>[\s\S]*?<\/script>/g) ?? [];
  assert.equal(scripts.length, 1, "多出/少了 script");
  assert.ok(scripts[0].includes("\\u003c"), "script 里的 < 没转义");
  assert.ok(!scripts[0].includes("</script><b>"), "script 被提前闭合");
});

test("没有 </head> 的畸形页面：补 <head> 塞在 <html> 后面，不许跑到 doctype 前面", () => {
  const bare = `<html><body>hi</body></html>`;
  const out = injectWindowTitle(bare, "测试 t9");
  assert.ok(out.startsWith("<html><head><script>"), out);
  assert.ok(out.indexOf("__piWindowTitle") < out.indexOf("<body>"), "脚本跑到 body 里了");

  const withDoctype = `<!doctype html><html><body>hi</body></html>`;
  const out2 = injectWindowTitle(withDoctype, "测试 t9");
  assert.ok(out2.startsWith("<!doctype html>"), "script 跑到 doctype 前面了（quirks 模式）");
  assert.ok(out2.indexOf("__piWindowTitle") < out2.indexOf("<body>"), "脚本跑到 body 里了");
});
