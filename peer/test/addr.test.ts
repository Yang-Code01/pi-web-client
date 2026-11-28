import assert from "node:assert/strict";
import { test } from "node:test";
import { hostForUrl, normAddr } from "../src/addr.ts";

// discovery 的 hasAddr、messages 的去重都靠 normAddr 比地址；改了归一规则就得有测试钉住
// （评审 7-20：discovery 自己没有任何覆盖）。
test("normAddr：IPv4-mapped、回环、带方括号的写法都归一到同一台", () => {
  assert.equal(normAddr("::ffff:192.168.1.7"), "192.168.1.7");
  assert.equal(normAddr("[::ffff:192.168.1.7]"), "192.168.1.7");
  assert.equal(normAddr("::1"), "127.0.0.1");
  assert.equal(normAddr("[::1]"), "127.0.0.1");
});

test("normAddr：普通 IPv6 只剥一层方括号，不改写", () => {
  assert.equal(normAddr("fe80::1"), "fe80::1");
  assert.equal(normAddr("[fe80::1]"), "fe80::1");
});

test("hostForUrl：IPv6 补回方括号，IPv4 与归一后的回环不加", () => {
  assert.equal(hostForUrl("fe80::1"), "[fe80::1]");
  assert.equal(hostForUrl("[fe80::1]"), "[fe80::1]");
  assert.equal(hostForUrl("192.168.1.7"), "192.168.1.7");
  assert.equal(hostForUrl("[::1]"), "127.0.0.1");
});
