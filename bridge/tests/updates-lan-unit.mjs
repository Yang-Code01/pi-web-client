/**
 * D441 更新组的两块纯函数：remote → `owner/name`，`owner/name` → 固定组 id。
 * 组 id 是跨机器对齐的唯一依据（没有服务器），所以这里把格式钉死。
 *
 * 用法：node --experimental-strip-types bridge/tests/updates-lan-unit.mjs
 */
import assert from "node:assert/strict";
import { ANNOUNCE_LIMITS, cutUtf8, groupIdFor, repoSlugFromRemote } from "../src/updates-lan.ts";
import {
  MAX_ANNOUNCE_BATCHES,
  MAX_ANNOUNCE_BATCH_BYTES,
  MAX_ANNOUNCE_BYTES,
  normalizeAnnounce,
  truncBytes,
} from "../../peer/src/announce.ts";

const cases = [
  ["git@github.com:Yang-Code01/pi-web-client.git", "Yang-Code01/pi-web-client"],
  ["git@github.com:Yang-Code01/pi-web-client", "Yang-Code01/pi-web-client"],
  ["https://github.com/Yang-Code01/pi-web-client.git", "Yang-Code01/pi-web-client"],
  ["https://github.com/Yang-Code01/pi-web-client", "Yang-Code01/pi-web-client"],
  ["https://github.com/Yang-Code01/pi-web-client/", "Yang-Code01/pi-web-client"],
  ["ssh://git@gitlab.local/Yang-Code01/pi-web-client.git", "Yang-Code01/pi-web-client"],
  // GitLab 的多层路径照收；.git 之后是网页路径，要切掉（评审 #2）。
  ["https://gitlab.com/group/subgroup/name", "group/subgroup/name"],
  ["https://github.com/owner/name.git/extra", "owner/name"],
  ["git@github.com:owner/name.git/extra", "owner/name"],
  // 带凭据的 URL：用户名密码必须被丢掉，不能进 slug、更不能进组名/announce。
  ["https://user:token@github.com/o/r.git", "o/r"],
  ["/srv/git/local.git", null],
  ["", null],
];
for (const [input, want] of cases) {
  assert.equal(repoSlugFromRemote(input), want, `repoSlugFromRemote(${JSON.stringify(input)})`);
}

// 组 id：只留 [a-z0-9-]，跨机器必须算出同一个（大小写、斜杠、下划线都归一）。
assert.equal(groupIdFor("Yang-Code01/pi-web-client"), "grp-updates-yang-code01-pi-web-client");
// `_` / `.` 被压平后与只把 `/` 换掉不同：加短哈希，避免 A_B/C.D 与 a-b/c-d 撞同一个组（评审 #2）。
assert.ok(groupIdFor("A_B/C.D").startsWith("grp-updates-a-b-c-d-"));
assert.notEqual(groupIdFor("A_B/C.D"), groupIdFor("a-b/c-d"));
assert.equal(groupIdFor("////"), "grp-updates-repo");
assert.ok(groupIdFor("x/".padEnd(200, "y")).length <= 80, "组 id 不超过 peer 的 80 字符上限");

// normalizeAnnounce：形状不对整条拒、超限只裁不丢（评审 #12）。
assert.equal(normalizeAnnounce(null), null);
assert.equal(normalizeAnnounce({ repo: "no-slash", commit: "abc1234", batches: [{ title: "a", body: "" }] }), null);
assert.equal(normalizeAnnounce({ repo: "o/r", commit: "not-hex", batches: [{ title: "a", body: "" }] }), null);
const seven = normalizeAnnounce({
  repo: "o/r",
  commit: "abc1234",
  batches: Array.from({ length: 7 }, (_, i) => ({ title: "t" + i, body: "b" })),
});
assert.equal(seven.batches.length, MAX_ANNOUNCE_BATCHES, "最多 6 批");
assert.equal(seven.batches[0].title, "t0", "保住最新那批（数组是新 → 旧）");
assert.equal(seven.batches[5].title, "t5", "丢的是最旧的");
const long = normalizeAnnounce({ repo: "o/r", commit: "abc1234", batches: [{ title: "t", body: "字".repeat(3000) }] });
assert.ok(Buffer.byteLength(long.batches[0].body, "utf8") <= 4096, "单批正文按 4 KB 截断");

// 两处上限与截断实现必须同步：bridge 不能 import peer 的模块（tsconfig rootDir），只能靠这条断言（评审 #3）。
assert.deepEqual(ANNOUNCE_LIMITS, {
  batches: MAX_ANNOUNCE_BATCHES,
  batchBytes: MAX_ANNOUNCE_BATCH_BYTES,
  bytes: MAX_ANNOUNCE_BYTES,
});
const sample = "字".repeat(5000);
for (const n of [1, 100, 4095, 4096, 16 * 1024]) assert.equal(cutUtf8(sample, n), truncBytes(sample, n), `cutUtf8 与 truncBytes 在 ${n} 字节上一致`);

console.log("✔ updates-lan 纯函数 全部通过");
