import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PASSPHRASE,
  chooseReusableEnv,
  findEnvCli,
  findReusableEnv,
  healthz,
  normalizeBaseUrl,
  pidAlive,
  readRegistry,
  registryPath,
  sameDir,
  staleBuild
} from "../lib/env.mjs";

test("test-dev env contract", () => {
  assert.equal(PASSPHRASE, "test");
  assert.match(registryPath(), /pi-web-test-dev[\\/]instances\.json$/);
});

test("readRegistry accepts the real { instances } shape and a bare array", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-env-"));
  const wrapped = path.join(dir, "wrapped.json");
  fs.writeFileSync(wrapped, JSON.stringify({ instances: [{ id: "a" }] }));
  assert.deepEqual(readRegistry(wrapped), [{ id: "a" }]);
  const bare = path.join(dir, "bare.json");
  fs.writeFileSync(bare, JSON.stringify([{ id: "b" }]));
  assert.deepEqual(readRegistry(bare), [{ id: "b" }]);
  assert.deepEqual(readRegistry(path.join(dir, "missing.json")), []);
});

test("findEnvCli points at the project test-dev CLI", () => {
  const repo = path.resolve(import.meta.dirname, "../../../..");
  const cli = findEnvCli(repo);
  assert.match(cli, /pi-web-client-test-dev[\\/]bin[\\/]env\.mjs$/);
});

test("normalizeBaseUrl adds http and strips trailing slashes", () => {
  assert.equal(normalizeBaseUrl("127.0.0.1:17864/"), "http://127.0.0.1:17864");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:17864///"), "http://127.0.0.1:17864");
  assert.equal(normalizeBaseUrl(""), "");
});

test("sameDir ignores separators, trailing slashes and case", () => {
  const dir = path.join(os.tmpdir(), "E2E-Same-Dir");
  assert.equal(sameDir(dir, `${dir}${path.sep}`), true);
  assert.equal(sameDir(dir, dir.toUpperCase()), true);
  assert.equal(sameDir(dir, path.join(os.tmpdir(), "other")), false);
  assert.equal(sameDir("", dir), false);
});

test("pidAlive: self is alive, a free pid is not", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(NaN), false);
  assert.equal(pidAlive(2 ** 22 + 12345), false);
});

test("staleBuild flags dist missing or older than src", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-stale-"));
  fs.mkdirSync(path.join(dir, "bridge", "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bridge", "src", "index.ts"), "// src");
  assert.deepEqual(staleBuild(dir), ["bridge/dist/index.js"]);
  fs.mkdirSync(path.join(dir, "bridge", "dist"), { recursive: true });
  const out = path.join(dir, "bridge", "dist", "index.js");
  fs.writeFileSync(out, "// dist");
  const future = Date.now() + 5000;
  fs.utimesSync(out, future / 1000, future / 1000);
  assert.deepEqual(staleBuild(dir), []);
  fs.utimesSync(path.join(dir, "bridge", "src", "index.ts"), future / 1000 + 10, future / 1000 + 10);
  assert.deepEqual(staleBuild(dir), ["bridge/dist/index.js"]);
});

test("healthz is false without a server", async () => {
  assert.equal(await healthz("http://127.0.0.1:1", 300), false);
  assert.equal(await healthz(""), false);
});

test("findReusableEnv reuses a live same-dir instance and never stops it", async () => {
  const repo = path.join(os.tmpdir(), "repo-find");
  const instances = [
    {
      id: "e2e-live",
      dir: repo,
      head: "",
      url: "http://127.0.0.1:17864/",
      pids: { bridge: process.pid },
      startedAt: "2026-01-01T00:00:00Z"
    }
  ];
  const logs = [];
  const reuse = await findReusableEnv({
    repoDir: repo,
    head: "",
    stale: [],
    instances,
    healthz: async () => true,
    log: (message) => logs.push(message)
  });
  assert.equal(reuse.id, "e2e-live");
  assert.equal(reuse.url, "http://127.0.0.1:17864");
  assert.equal(reuse.reused, true);
  assert.match(logs.join("\n"), /复用已在跑的测试环境 e2e-live/);

  const fallback = await findReusableEnv({
    repoDir: repo,
    head: "",
    stale: [],
    instances,
    healthz: async () => false,
    log: (message) => logs.push(message)
  });
  assert.equal(fallback, null);
  assert.match(logs.join("\n"), /不响应健康检查，另起一份/);
});

test("chooseReusableEnv only takes a live instance of the same dir and code", () => {
  const repo = path.join(os.tmpdir(), "repo-dir");
  const base = { dir: repo, head: "abc123", url: "http://127.0.0.1:17864", pids: { bridge: 1 } };
  const instances = [
    { ...base, id: "t1", startedAt: "2026-01-02T00:00:00Z" },
    { ...base, id: "e2e-old", startedAt: "2026-01-01T00:00:00Z" },
    { ...base, id: "e2e-new", startedAt: "2026-01-03T00:00:00Z" },
    { ...base, id: "other-dir", dir: path.join(os.tmpdir(), "elsewhere") },
    { ...base, id: "old-head", head: "def456" },
    { ...base, id: "no-url", url: "" }
  ];
  const pick = chooseReusableEnv(instances, { repoDir: repo, head: "abc123" });
  assert.equal(pick.id, "e2e-new");
  assert.equal(
    chooseReusableEnv(instances, { repoDir: repo, head: "abc123", alive: (item) => !item.id.startsWith("e2e-") }).id,
    "t1"
  );
  assert.equal(chooseReusableEnv(instances, { repoDir: repo, head: "abc123", alive: () => false }), null);
  assert.equal(chooseReusableEnv(instances, { repoDir: repo, head: "abc123", stale: ["web/dist/index.html"] }), null);
  assert.equal(chooseReusableEnv(instances, { repoDir: path.join(os.tmpdir(), "none"), head: "abc123" }), null);
});
