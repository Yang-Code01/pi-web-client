import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PASSPHRASE,
  findEnvCli,
  normalizeBaseUrl,
  readRegistry,
  registryPath
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
