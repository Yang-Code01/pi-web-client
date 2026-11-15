/**
 * Browser-level tests for `web/src/mailhtml.ts`.
 *
 * `renderMailHtml()` needs a real `DOMParser`, so this file bundles the module with esbuild and
 * runs it in a Chromium page (same pattern as the repo's probes). It is separate from `test:mail`
 * because it needs a downloaded Playwright browser; run it with `npm run test:mail:html`.
 *
 *   node web/tests/mailhtml-browser.mjs
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { loadPlaywright } from "../../tools/playwright.mjs";

const bundled = await build({
  entryPoints: [new URL("../src/mailhtml.ts", import.meta.url).pathname],
  bundle: true,
  format: "iife",
  globalName: "MailHtml",
  platform: "browser",
  write: false,
  logLevel: "silent",
});
const code = bundled.outputFiles[0].text;
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body></body></html>");
await page.addScriptTag({ content: code });

const out = await page.evaluate(() => {
  const attachments = [
    { index: 0, filename: "logo.png", contentType: "image/png", size: 10, contentId: "<Logo@X>", inline: true },
    { index: 1, filename: "bg.png", contentType: "image/png", size: 10, contentId: "bg@x", inline: true },
  ];
  const html = `
    <html><head><style>@import url(https://evil.test/x.css);
      body { background: url(https://evil.test/bg.png); color: #123456 }
    </style></head>
    <body onload="alert(1)">
      <script>alert(2)</script><iframe src="https://evil.test"></iframe>
      <p style="background:url('https://evil.test/inline.png')">hello <img src="cid:Logo%40X" alt="logo"></p>
      <img src="https://evil.test/track.gif" width="20" height="10">
      <img srcset="https://evil.test/srcset-only.png 1x, https://evil.test/2x.png 2x" alt="srcset">
      <a href="javascript:alert(3)">bad</a><a href="https://ok.test">ok</a>
    </body></html>`;
  const blocked = MailHtml.renderMailHtml(html, {
    attachments,
    allowRemote: false,
    inlineUrl: (a) => `/api/mail/attachment?uid=9&index=${a.index}&inline=1`,
  });
  const shown = MailHtml.renderMailHtml(html, { attachments, allowRemote: true, inlineUrl: () => "/inline" });
  return {
    blocked,
    shown,
    blockedFrame: MailHtml.buildMailFrameHtml(blocked, false),
    shownFrame: MailHtml.buildMailFrameHtml(shown, true),
    srcset: MailHtml.firstSrcsetUrl("https://x.test/a.png 1x, https://x.test/b.png 2x"),
  };
});

await browser.close();

// 清理与 cid 映射
assert.ok(!out.blocked.html.includes("<script"), "script 被清掉");
assert.ok(!out.blocked.html.includes("<iframe"), "iframe 被清掉");
assert.ok(!out.blocked.html.includes("onload="), "on* 属性被清掉");
assert.ok(!out.blocked.html.includes("javascript:"), "javascript: href 被清掉");
assert.ok(out.blocked.html.includes('src="/api/mail/attachment?uid=9&amp;index=0&amp;inline=1"'), "cid 图片映射到附件直链");
assert.ok(out.blocked.html.includes("background:none"), "远程 CSS 背景被拦");

// 远程图默认拦截；srcset-only 也要算一张图
assert.equal(out.blocked.remoteImages, 2, `远程 <img> 应为 2 张（track + srcset-only），实际 ${out.blocked.remoteImages}`);
assert.equal(out.blocked.remoteCss, 2, "远程背景图应为 2 个（body + p style）");
assert.ok((out.blocked.html.match(/data-mc-blocked/g) ?? []).length >= 2, "远程图都标成 blocked");
assert.match(out.blockedFrame, /img-src data: blob: 'self';/);
assert.ok(!out.blockedFrame.includes("https: http:"), "默认 CSP 不放远程图");

// 放行后恢复原 src，CSP 才允许远程
assert.equal(out.shown.remoteImages, 2);
assert.match(out.shown.html, /src="https:\/\/evil\.test\/track\.gif"/);
assert.match(out.shown.html, /src="https:\/\/evil\.test\/srcset-only\.png"/);
assert.match(out.shownFrame, /img-src data: blob: 'self' https: http:/);
assert.equal(out.srcset, "https://x.test/a.png");

console.log("ok mailhtml-browser: 清理 / cid 映射 / remoteImages / srcset / CSP 放行");
