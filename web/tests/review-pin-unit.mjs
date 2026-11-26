/**
 * 「评审仓库」的面板视图 + 名字归一：钉住的仓库要在抬头写成一枚 chip，not-git 时换成
 * 「选一个仓库」。判据错一个（比如没钉子也画 ×，或者 chip 写全路径把右栏撑爆），
 * 用户看到的就是「明明选了子仓库，面板还说他评的是会话目录」。
 *
 *   node --experimental-strip-types web/tests/review-pin-unit.mjs
 *
 * 为什么要那段 css stub：`review.ts` → `chat.ts` → `github-cards.ts` 会静态 import 一个 `.css`，
 * Node 不认这个扩展名。这里只把样式文件的**内容**吞掉，模块图其余部分照原样加载。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  load(url, context, next) {
    if (url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true };
    return next(url, context);
  },
});

const { repoNameOf, reviewView } = await import("../src/review.ts");

const ocrOk = { installed: true, version: "9.9.9", tooOld: false };
const base = { ocr: ocrOk, installing: false, error: "", notGit: false, progress: null };
const emptyState = { runs: [], marks: {} };

test("没钉钉子：不画仓库行", () => {
  const view = reviewView({ ...base, state: null, notGit: true, repo: "" });
  assert.equal(view.repo, "");
  assert.equal(view.repoName, "");
  assert.equal(view.repoPinned, false);
  assert.equal(view.phase, "not-git", "会话目录不是仓库、也没选子仓库：还是那句「没有东西可评」");
});

test("钉住了子仓库：chip 只写末段，并且能看出可以清", () => {
  const view = reviewView({ ...base, state: emptyState, repo: "E:/big/erp/api", repoPinned: true, mode: "workspace" });
  assert.equal(view.repo, "E:/big/erp/api");
  assert.equal(view.repoName, "api");
  assert.equal(view.repoPinned, true);
  assert.equal(view.phase, "empty");
  assert.equal(view.canRun, true, "钉住的子仓库选好了就应该能开跑");
});

test("桥算出了仓库根但人没钉：行照样显示（会话目录本身就是仓库），但没有 ×", () => {
  const view = reviewView({ ...base, state: emptyState, repo: "E:/big/solid", repoPinned: false, mode: "workspace" });
  assert.equal(view.repoName, "solid");
  assert.equal(view.repoPinned, false, "没钉子就不该给「回到会话目录」");
});

test("repoNameOf：尾斜杠、反斜杠、盘根、空串", () => {
  assert.equal(repoNameOf("E:/big/erp/api/"), "api");
  assert.equal(repoNameOf("E:\\big\\erp\\api"), "api");
  assert.equal(repoNameOf("api"), "api");
  assert.equal(repoNameOf("E:/"), "E:/", "盘根没有末段，别回空串");
  assert.equal(repoNameOf(""), "");
});
