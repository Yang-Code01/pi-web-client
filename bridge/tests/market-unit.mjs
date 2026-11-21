/**
 * The MCP index walk and the stars table, without the network (D379).
 *
 * Three things used to be wrong and each is pinned here: a 4xx page threw the whole walk away, a walk
 * that died started over at page 0, and a GraphQL 200 with `errors` / `null` nodes was reported as
 * "stars complete" while the entries it did not answer for sat at 0.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { needsLooseRecall, pageRefused, readStarsBatch, walkIndex, walkToResume } from "../src/market.ts";

const HOUR = 3600_000;

test("pageRefused: a page the registry will not hand over vs. one worth retrying", () => {
  for (const status of [400, 403, 404, 410, 422]) {
    assert.equal(pageRefused(Object.assign(new Error("no"), { status })), true, `status ${status} is a refusal`);
  }
  for (const status of [408, 429, 500, 502, 503]) {
    assert.equal(pageRefused(Object.assign(new Error("later"), { status })), false, `status ${status} is transient`);
  }
  // No status at all is a dead socket, not a refusal.
  assert.equal(pageRefused(new Error("socket hang up")), false);
  assert.equal(pageRefused(undefined), false);
});

test("readStarsBatch: only what the answer states counts as known", () => {
  const full = readStarsBatch(JSON.stringify({ data: { r0: { stargazerCount: 12 }, r1: { stargazerCount: 0 } } }), ["https://github.com/a/one", "https://github.com/a/two"]);
  assert.equal(full.complete, true);
  assert.deepEqual([...full.stars], [["https://github.com/a/one", 12], ["https://github.com/a/two", 0]]);

  // A repo that is gone / renamed / private comes back as a null node: unknown, not zero.
  const gone = readStarsBatch(JSON.stringify({ data: { r0: { stargazerCount: 7 }, r1: null } }), ["https://github.com/a/one", "https://github.com/a/two"]);
  assert.equal(gone.complete, false);
  assert.deepEqual([...gone.stars], [["https://github.com/a/one", 7]]);

  // Rate limits and bad nodes ride on a 200 as `errors`; the numbers that did arrive still count.
  const partial = readStarsBatch(JSON.stringify({ data: { r0: { stargazerCount: 3 } }, errors: [{ message: "Could not resolve to a Repository" }] }), ["https://github.com/a/one", "https://github.com/a/two"]);
  assert.equal(partial.complete, false);
  assert.deepEqual([...partial.stars], [["https://github.com/a/one", 3]]);

  // A slot that is not a GitHub repo asks nothing, so it cannot make the batch incomplete.
  const skipped = readStarsBatch(JSON.stringify({ data: { r0: { stargazerCount: 5 } } }), ["https://github.com/a/one", null]);
  assert.equal(skipped.complete, true);
  assert.deepEqual([...skipped.stars], [["https://github.com/a/one", 5]]);

  const junk = readStarsBatch("<html>502</html>", ["https://github.com/a/one"]);
  assert.equal(junk.complete, false);
  assert.equal(junk.stars.size, 0);
});

test("walkToResume: a checkpoint is only trusted while it still describes this registry", () => {
  const now = 1_700_000_000_000;
  const items = [{ name: "ac.inference.sh/mcp", title: "AC", version: "1.0.0", repo: null, stars: 0 }];
  const saved = { v: 2, at: now - HOUR, cursor: "abc", pages: 25, items };

  assert.deepEqual(walkToResume(saved, now), { at: saved.at, cursor: "abc", pages: 25, items });

  // A checkpoint from an older schema cannot be merged into today's items.
  assert.equal(walkToResume({ ...saved, v: 1 }, now), null);
  // Too old to be worth resuming: the registry has moved on.
  assert.equal(walkToResume({ ...saved, at: now - 7 * HOUR }, now), null);
  // Exactly at the window is still allowed (the boundary is `>`, not `>=`).
  assert.ok(walkToResume({ ...saved, at: now - 6 * HOUR }, now));
  // Half-written or hand-edited files are rejected rather than crashing the walk.
  assert.equal(walkToResume({ ...saved, items: null }, now), null);
  assert.equal(walkToResume({ ...saved, pages: "25" }, now), null);
  assert.equal(walkToResume({ ...saved, cursor: 42 }, now), null);
  assert.equal(walkToResume({ ...saved, at: Number.NaN }, now), null);
  assert.equal(walkToResume(null, now), null);
  assert.equal(walkToResume("{}", now), null);
});

/** One registry page: names → entries, plus the cursor for the page after it. */
function page(names, next) {
  return {
    servers: names.map((name) => ({ server: { name, version: "1.0.0", remotes: [{ url: `https://${name}.example/mcp`, type: "streamable-http" }] } })),
    ...(next ? { metadata: { nextCursor: next } } : {}),
  };
}

const byName = (result) => result.map((it) => it.name).sort();

const PAGES = {
  null: page(["a/one", "a/two"], "c1"),
  c1: page(["b/three"], "c2"),
  c2: page(["c/four"], "c3"),
  c3: page(["d/five"]),
};

test("walkIndex: a dead page checkpoints, and the next walk continues from there", async () => {
  const checkpoints = [];
  const fetched = [];
  await assert.rejects(
    walkIndex({
      resume: null,
      every: 2,
      fetchPage: async (cursor) => {
        fetched.push(cursor);
        if (cursor === "c2") throw Object.assign(new Error("502"), { status: 502 });
        return PAGES[cursor];
      },
      checkpoint: (state) => checkpoints.push(state),
    }),
    /502/,
  );
  // Every second page was checkpointed; the failing one was checkpointed *before* it threw.
  assert.deepEqual(fetched, [null, "c1", "c2"]);
  assert.equal(checkpoints.length, 2);
  const resume = checkpoints.at(-1);
  assert.equal(resume.pages, 2);
  assert.equal(resume.cursor, "c2");
  assert.deepEqual(byName(resume.items), ["a/one", "a/two", "b/three"]);

  // Second walk: starts at the checkpoint, walks page 2 and 3 only, ends with all four pages.
  const again = [];
  const done = await walkIndex({
    resume: { ...resume, v: 2 },
    every: 2,
    fetchPage: async (cursor) => {
      again.push(cursor);
      return PAGES[cursor];
    },
    checkpoint: () => assert.fail("a finished walk has nothing to checkpoint"),
  });
  assert.deepEqual(again, ["c2", "c3"]);
  assert.equal(done.pages, 4);
  assert.equal(done.cursor, null);
  assert.equal(done.refused, false);
  assert.deepEqual(byName(done.items), ["a/one", "a/two", "b/three", "c/four", "d/five"]);
});

test("walkIndex: a refused page keeps the pages already collected instead of throwing", async () => {
  const checkpoints = [];
  const done = await walkIndex({
    resume: null,
    fetchPage: async (cursor) => {
      if (cursor === "c1") throw Object.assign(new Error("404"), { status: 404 });
      return PAGES[cursor];
    },
    checkpoint: (state) => checkpoints.push(state),
  });
  assert.equal(done.refused, true);
  assert.equal(done.pages, 1);
  assert.equal(done.cursor, "c1");
  assert.deepEqual(byName(done.items), ["a/one", "a/two"]);
  assert.deepEqual(checkpoints, []);
});

test("walkIndex: a resumed page merges into what the checkpoint already had", async () => {
  const old = { name: "a/one", title: "one", description: "", version: "0.9.0", repo: null, stars: 0, options: [] };
  const done = await walkIndex({
    resume: { at: Date.now(), cursor: null, pages: 0, items: [old] },
    fetchPage: async () => page(["a/one"], undefined),
    checkpoint: () => {},
  });
  assert.equal(done.items.length, 1, "the same server must not appear twice");
  assert.equal(done.items[0].version, "1.0.0", "the newer version wins");
});

test("needsLooseRecall: only when nothing matched by name", () => {
  const pkg = (name, description = "") => ({ name, title: name, description, version: "1.0.0", monthly: 1, published: 0, keywords: [], blocked: false });
  const hot = pkg("some-popular-thing", "a search helper for chinese text");
  const cold = pkg("@scope/正字-search", "");
  // 名字里已经命中 → 不再发第二次请求
  assert.equal(needsLooseRecall([hot, pkg("chinese-helper")], "chinese"), false);
  assert.equal(needsLooseRecall([cold], "正字"), false, "scoped packages count by their tail");
  // 只有描述/关键词命中 → 名字可能在 250 名之外，该补一次
  assert.equal(needsLooseRecall([hot], "chinese"), true);
  // 零结果、CJK 查询（keywords 分词对不上）也要补
  assert.equal(needsLooseRecall([], "看不懂的查询"), true);
  assert.equal(needsLooseRecall([hot], "   "), false, "an empty query never recalls");
});
