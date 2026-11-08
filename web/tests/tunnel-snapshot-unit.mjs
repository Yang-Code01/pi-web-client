/**
 * 隧道快照只许往新了盖（D194）：公网页面重连频繁，早于「关掉」发出的 hello 会落在关掉之后。
 *
 * Run: node --experimental-transform-types web/tests/tunnel-snapshot-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { newerTunnel } from "../src/tunnel-snapshot.ts";

const up = (t) => ({ status: "up", url: "https://a.trycloudflare.com", updatedAt: t });
const off = (t) => ({ status: "off", url: null, updatedAt: t });

test("旧的 hello 不许把 off 盖回 up（用户看到按钮又变『关掉公网隧道』）", () => {
  const now = off(1000);
  assert.equal(newerTunnel(now, up(900)).status, "off");
  assert.equal(newerTunnel(now, up(999)).status, "off");
});

test("同样时间戳也收（stop 的 off 与回包同一毫秒时不至于被吞）", () => {
  assert.equal(newerTunnel(up(1000), off(1000)).status, "off");
});

test("更新的照收：别人在另一个标签页开了隧道", () => {
  assert.equal(newerTunnel(off(1000), up(1001)).status, "up");
});

test("hello 没带 tunnel 就保持原样（同一个对象，不新建）", () => {
  const cur = up(5);
  assert.equal(newerTunnel(cur, null), cur);
  assert.equal(newerTunnel(cur, undefined), cur);
});
