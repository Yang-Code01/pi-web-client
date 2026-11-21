import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  currentBranch,
  gitInfo,
  mainRoot,
  mergeBase,
  resolveCommit,
  shortHead
} from "../lib/worktree.mjs";

const repo = path.resolve(import.meta.dirname, "../../../..");

test("mainRoot finds the main checkout from this worktree", () => {
  const main = mainRoot(repo);
  assert.equal(path.basename(main), "pi-web-client");
  assert.ok(path.isAbsolute(main));
});

test("HEAD and merge-base are real commits", () => {
  const head = resolveCommit(repo, "HEAD");
  assert.match(head, /^[0-9a-f]{40}$/);
  assert.match(shortHead(repo), /^[0-9a-f]{7,}$/);
  const base = mergeBase(repo, "main");
  assert.match(base, /^[0-9a-f]{40}$/);
});

test("gitInfo reports a branch and dirty state without throwing", () => {
  const info = gitInfo(repo);
  assert.equal(info.dir, repo);
  assert.equal(typeof info.branch, "string");
  assert.equal(typeof info.dirty, "boolean");
  assert.match(info.head, /^[0-9a-f]{7,}$/);
  assert.doesNotThrow(() => currentBranch(repo));
});
