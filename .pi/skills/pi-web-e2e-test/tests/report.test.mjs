import test from "node:test";
import assert from "node:assert/strict";
import { renderReport } from "../lib/report.mjs";

function side(overrides = {}) {
  return {
    status: "pass",
    video: "media/after.mp4",
    vtt: "media/after.vtt",
    poster: "media/after.jpg",
    tFinalStart: 0,
    tFinalEnd: 8,
    duration: 8,
    steps: [{ title: "打开菜单", tFinal: 0, audioDuration: 2 }],
    asserts: [],
    errors: [],
    console: [],
    network: [],
    ...overrides
  };
}

function baseSpec(overrides = {}) {
  return {
    schema: 1,
    title: "测试报告",
    generatedAt: "2026-11-22T00:00:00.000Z",
    fps: 25,
    meta: {},
    git: { before: null, after: { branch: "feat/e2e-test-skill", head: "3b57dddaa" } },
    env: { before: null, after: { url: "http://127.0.0.1:17876/" } },
    sides: { after: side() },
    cases: [],
    summary: {},
    ...overrides
  };
}

test("bug report: renders symptom, cause, fix and the repro video", () => {
  const html = renderReport({
    mode: "bug",
    title: "draft bug",
    spec: baseSpec({
      meta: {
        title: "提交后草稿没有清空",
        symptom: "发送后输入框还留着文字。",
        expected: "输入框为空。",
        actual: "文字仍在。",
        causeHtml: "<p>根因在 <code>web/src/app.ts:1234</code>。</p>",
        fixHtml: "<p>在 <code>send()</code> 里清空 <code>draft</code>。</p>",
        issue: "https://github.com/Yang-Code01/pi-web-client/issues/616"
      },
      cases: [
        {
          id: "repro",
          title: "发送后草稿",
          expect: "输入框为空",
          verdict: "fail",
          before: null,
          after: side({ status: "fail" })
        }
      ]
    })
  });

  assert.match(html, /BUG 复现/);
  assert.match(html, /提交后草稿没有清空/);
  assert.match(html, /发送后输入框还留着文字/);
  assert.match(html, /web\/src\/app\.ts:1234/);
  assert.match(html, /send\(\)/);
  assert.match(html, /media\/after\.mp4/);
  assert.match(html, /media\/after\.vtt/);
  assert.match(html, /打开菜单/);
  assert.match(html, /未落盘/);
  assert.match(html, /issues\/616/);
});

test("bug report: escapes text fields but keeps causeHtml/fixHtml as html", () => {
  const html = renderReport({
    mode: "bug",
    spec: baseSpec({
      meta: {
        title: "<script>alert(1)</script>",
        symptom: "<b>不是 html</b>",
        causeHtml: "<p>允许的 <b>html</b></p>",
        fixHtml: "<p>方案</p>"
      }
    })
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<b>不是 html<\/b>/);
  assert.match(html, /允许的 <b>html<\/b>/);
});

test("change report: renders before/after videos, verdicts, coverage and source", () => {
  const html = renderReport({
    mode: "change",
    title: "sort",
    spec: baseSpec({
      meta: {
        title: "会话列表支持按名称排序",
        changeTitle: "会话列表排序",
        summary: "切换后立即按名称重排。",
        source: "spec.md §2.3 / PR #612",
        coverage: [
          { item: "切换排序", status: "covered", note: "case 1" },
          { item: "刷新后保持", status: "not-covered", note: "下一轮" }
        ],
        uncovered: ["重启后的持久化"]
      },
      sides: {
        before: side({
          video: "media/before.mp4",
          vtt: "media/before.vtt",
          status: "fail",
          tFinalStart: 1,
          tFinalEnd: 9
        }),
        after: side({ video: "media/after.mp4", vtt: "media/after.vtt" })
      },
      git: {
        before: { head: "abc1234" },
        after: { branch: "feat/sort", head: "def5678" }
      },
      env: {
        before: { url: "http://127.0.0.1:17880/" },
        after: { url: "http://127.0.0.1:17882/" }
      },
      cases: [
        {
          id: "sort",
          title: "切换排序",
          expect: "立即重排",
          verdict: "fixed",
          before: side({ status: "fail", video: "media/before.mp4" }),
          after: side({ status: "pass", video: "media/after.mp4" })
        }
      ]
    })
  });

  assert.match(html, /变更验收/);
  assert.match(html, /会话列表支持按名称排序/);
  assert.match(html, /切换后立即按名称重排/);
  assert.match(html, /spec\.md §2\.3 \/ PR #612/);
  assert.match(html, /media\/before\.mp4/);
  assert.match(html, /media\/after\.mp4/);
  assert.match(html, /已修复/);
  assert.match(html, /修改前/);
  assert.match(html, /修改后/);
  assert.match(html, /切换排序/);
  assert.match(html, /not-covered/);
  assert.match(html, /重启后的持久化/);
  assert.match(html, /abc1234/);
  assert.match(html, /def5678/);
  assert.match(html, /17880/);
  assert.match(html, /17882/);
});

test("change report: missing cases still render a usable page", () => {
  const html = renderReport({
    mode: "change",
    spec: baseSpec({
      sides: { before: side(), after: side() },
      cases: [],
      meta: { title: "空报告" }
    })
  });
  assert.match(html, /没有用例/);
  assert.match(html, /未提供覆盖矩阵/);
});
