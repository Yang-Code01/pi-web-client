/**
 * D451 更新组的两块纯函数：remote → `owner/name`，`owner/name` → 固定组 id。
 * 组 id 是跨机器对齐的唯一依据（没有服务器），所以这里把格式钉死。
 *
 * 用法：node --experimental-strip-types bridge/tests/updates-lan-unit.mjs
 */
import assert from "node:assert/strict";
import { isRepo, MAX_REPO_LEN } from "../../peer/src/repo.ts";
import { ANNOUNCE_LIMITS, batchesAfter, cutUtf8, groupIdFor, localDay, repoSlugFromRemote } from "../src/updates-lan.ts";
import {
  MAX_ANNOUNCE_BATCHES,
  MAX_ANNOUNCE_BATCH_BYTES,
  MAX_ANNOUNCE_BYTES,
  normalizeAnnounce,
  truncBytes,
} from "../../peer/src/announce.ts";

const cases = [
  ["git@github.com:Yang-Code01/pi-web-client.git", "github.com/Yang-Code01/pi-web-client"],
  ["git@github.com:Yang-Code01/pi-web-client", "github.com/Yang-Code01/pi-web-client"],
  ["https://github.com/Yang-Code01/pi-web-client.git", "github.com/Yang-Code01/pi-web-client"],
  ["https://github.com/Yang-Code01/pi-web-client", "github.com/Yang-Code01/pi-web-client"],
  ["https://github.com/Yang-Code01/pi-web-client/", "github.com/Yang-Code01/pi-web-client"],
  ["ssh://git@gitlab.local/Yang-Code01/pi-web-client.git", "gitlab.local/Yang-Code01/pi-web-client"],
  // 显式端口：git@host:22:owner/name 与 ssh://git@host:22/owner/name 都要认（评审 #1）。
  ["git@github.com:22:owner/name.git", "github.com/owner/name"],
  ["ssh://git@github.com:22/owner/name.git", "github.com/owner/name"],
  // GitLab 的多层路径照收；.git 之后是网页路径，要切掉（评审 #2）。
  ["https://gitlab.com/group/subgroup/name", "gitlab.com/group/subgroup/name"],
  ["https://github.com/owner/name.git/extra", "github.com/owner/name"],
  ["git@github.com:owner/name.git/extra", "github.com/owner/name"],
  // 带凭据的 URL：用户名密码必须被丢掉，不能进 slug、更不能进组名/announce。
  ["https://user:token@github.com/o/r.git", "github.com/o/r"],
  // 主机大小写 / 协议 / 结尾的 .git 都不影响标识（主机按小写归一）。
  ["https://GitHub.com/o/r", "github.com/o/r"],
  ["/srv/git/local.git", null],
  ["", null],
];
// 主机是标识的一部分：不同托管站上的同名 owner/name 不能并进同一个组（评审 #1）。
assert.notEqual(repoSlugFromRemote("https://github.com/a/b"), repoSlugFromRemote("https://gitlab.local/a/b"));
assert.notEqual(groupIdFor(repoSlugFromRemote("https://github.com/a/b")), groupIdFor(repoSlugFromRemote("https://gitlab.local/a/b")));
assert.equal(
  repoSlugFromRemote("https://github.com/a/b"),
  repoSlugFromRemote("git@github.com:a/b.git"),
  "同一个仓库换个协议写，标识要一致",
);
for (const [input, want] of cases) {
  assert.equal(repoSlugFromRemote(input), want, `repoSlugFromRemote(${JSON.stringify(input)})`);
}

assert.ok(isRepo("owner/name"));
assert.ok(!isRepo("o/" + "n".repeat(MAX_REPO_LEN)), "超过 peer config 上限的仓库标识不合法（评审 #27）");

// 组 id：只留 [a-z0-9-] + 短哈希；跨机器必须算出同一个（大小写、斜杠、下划线都归一）。
assert.ok(groupIdFor("github.com/Yang-Code01/pi-web-client").startsWith("grp-updates-github-com-yang-code01-pi-web-client-"));
assert.notEqual(groupIdFor("A_B/C.D"), groupIdFor("a-b/c-d"));
// `/`、`-`、`_` 压平后同名（a-b/c、a/b-c、a/b/c）：哈希必须把它们分开（评审 #1）。
assert.equal(new Set(["a-b/c", "a/b-c", "a/b/c"].map(groupIdFor)).size, 3);
assert.ok(groupIdFor("////").startsWith("grp-updates-repo-"));
assert.ok(groupIdFor("x/".padEnd(200, "y")).length <= 80, "组 id 不超过 peer 的 80 字符上限");

// bridge 真算出来的组 id 必须能被 peer 收下（评审 #6）：带主机的最长常见标识贴着 80 字符上限，
// 超一个字 peer 的 normalizeGroup / createGroup 就会整条拒掉，而 e2e 里手写的常量验不到这件事。
// peer 那边（groups.ts 的 normalizeGroup / messages.ts 的 createGroup）只收 `grp-` 开头、
// `^[a-zA-Z0-9_-]+$`、≤80 字符的 id；groups.ts 用了 TS 参数属性，strip-only 模式 import 不了它，
// 所以这里按同一条规则复核（见文件抬头那条「两处上限必须同步」的同类做法）。
const realRepo = repoSlugFromRemote("git@github.com:Yang-Code01/pi-web-client.git");
const realGroup = groupIdFor(realRepo);
assert.ok(realGroup.startsWith("grp-"), `真组 id 要带 grp- 前缀：${realGroup}`);
assert.ok(/^[a-zA-Z0-9_-]+$/.test(realGroup), `真组 id 只能用字母数字下划线短横线：${realGroup}`);
assert.ok(realGroup.length <= 80, `真组 id 不超 peer 的 80 字符上限（实际 ${realGroup.length}）`);

// 公告里的日期是本地日期：`toISOString()` 在北京时间 0–8 点会写成前一天（评审 #4）。
assert.equal(localDay(new Date(2026, 0, 1, 0, 30).getTime()), "2026-01-01", "凌晨 0:30 写本地的这一天");
assert.equal(localDay(new Date(2026, 11, 31, 23, 59).getTime()), "2026-12-31");

// 切批次：`lastBatchTitle` 之前的新批次全都要推，不能只推最新一批（评审 #2）。
const batchLog = [
  { title: "t3", body: "" },
  { title: "t2", body: "" },
  { title: "t1", body: "" },
  { title: "t0", body: "" },
];
assert.deepEqual(batchesAfter(batchLog, "t1").map((b) => b.title), ["t3", "t2"], "上次播 t1：t3/t2 两批都要发");
assert.deepEqual(batchesAfter(batchLog, "").map((b) => b.title), ["t3"], "没记标题时只能推最新一批 —— 所以基线必须记标题");
assert.deepEqual(batchesAfter(batchLog, "gone").map((b) => b.title), ["t3"], "上次那批已不在文件里：别重播整份日志");
assert.deepEqual(batchesAfter([], "t1"), []);
assert.deepEqual(batchesAfter(batchLog, "t3"), [], "同一批不重播");

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
