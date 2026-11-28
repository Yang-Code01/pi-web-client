/**
 * D441 更新组的两块纯函数：remote → `owner/name`，`owner/name` → 固定组 id。
 * 组 id 是跨机器对齐的唯一依据（没有服务器），所以这里把格式钉死。
 *
 * 用法：node --experimental-strip-types bridge/tests/updates-lan-unit.mjs
 */
import assert from "node:assert/strict";
import { groupIdFor, repoSlugFromRemote } from "../src/updates-lan.ts";

const cases = [
  ["git@github.com:Yang-Code01/pi-web-client.git", "Yang-Code01/pi-web-client"],
  ["git@github.com:Yang-Code01/pi-web-client", "Yang-Code01/pi-web-client"],
  ["https://github.com/Yang-Code01/pi-web-client.git", "Yang-Code01/pi-web-client"],
  ["https://github.com/Yang-Code01/pi-web-client", "Yang-Code01/pi-web-client"],
  ["https://github.com/Yang-Code01/pi-web-client/", "Yang-Code01/pi-web-client"],
  ["ssh://git@gitlab.local/Yang-Code01/pi-web-client.git", "Yang-Code01/pi-web-client"],
  ["https://user:token@github.com/o/r.git", "o/r"],
  ["/srv/git/local.git", null],
  ["", null],
];
for (const [input, want] of cases) {
  assert.equal(repoSlugFromRemote(input), want, `repoSlugFromRemote(${JSON.stringify(input)})`);
}

// 组 id：只留 [a-z0-9-]，跨机器必须算出同一个（大小学、斜杠、下划线都归一）。
assert.equal(groupIdFor("Yang-Code01/pi-web-client"), "grp-updates-yang-code01-pi-web-client");
assert.equal(groupIdFor("A_B/C.D"), "grp-updates-a-b-c-d");
assert.equal(groupIdFor("////"), "grp-updates-repo");
assert.ok(groupIdFor("x/".padEnd(200, "y")).length <= 80, "组 id 不超过 peer 的 80 字符上限");

console.log("✔ updates-lan 纯函数 全部通过");
