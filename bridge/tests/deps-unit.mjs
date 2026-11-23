/**
 * 「本项目需要」这份清单的判断逻辑（`bridge/src/deps.ts`）：版本比较、来源拆解、跟 `pi list`
 * 的结果配对。全是纯函数，这里只喂字符串与假行，不跑真 pi。
 *
 * 下面断言里的版本号（1.6.0 / 0.90.0 / 2.15.0）**抄自 `bridge/src/deps.ts`**；README「这个项目
 * 需要什么」那张表也是抄的，最后一段把它和清单对一遍，改下限时三处一起改。
 *
 *   node bridge/tests/deps-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bareSource,
  bootstrapCommand,
  compareSemver,
  depAction,
  depStatus,
  pendingCount,
  foundPackages,
  installSource,
  MIN_PI_VERSION,
  missingCount,
  OPTIONAL_PACKAGES,
  parseSemver,
  piTooOld,
  REQUIRED_PACKAGES,
  sourceName,
} from "../src/deps.ts";
import { statusFromList } from "../src/depsstatus.ts";

// ---------------------------------------------------------------- 版本

assert.deepEqual(parseSemver("1.5.0"), [1, 5, 0]);
assert.deepEqual(parseSemver("v2"), [2, 0, 0]);
assert.deepEqual(parseSemver("1.4.9-beta.3"), [1, 4, 9], "预发布号不算另一版");
assert.equal(parseSemver("nightly"), null);

assert.equal(compareSemver("1.5.0", "1.5.0"), 0);
assert.equal(compareSemver("1.4.9", "1.5.0"), -1);
assert.equal(compareSemver("1.5.1", "1.5.0"), 1);
assert.equal(compareSemver("2.0.0", "10.0.0"), -1, "按数字比，不按字符串");
assert.equal(compareSemver("乱写的", "1.0.0"), -1, "解析不出来当 0：宁可说太旧，不静默放行");

assert.equal(MIN_PI_VERSION, "1.6.0");
assert.equal(piTooOld("1.5.9"), true, "1.5 那组组合没验过：低于 1.6.0 一律算旧");
assert.equal(piTooOld("1.6.0"), false);
assert.equal(piTooOld("1.6.0-rc.1"), true, "预发布版比正式版旧（semver）：1.6.0-rc.1 不够 1.6.0");
assert.equal(piTooOld("1.6.1-rc.1"), false, "下一版的预发布已经比 1.6.0 新");
assert.equal(compareSemver("1.5.0-rc.1", "1.5.0"), -1);
assert.equal(compareSemver("1.5.0", "1.5.0-rc.1"), 1);
assert.equal(compareSemver("1.5.0-rc.1", "1.5.0-rc.2"), 0, "预发布号之间不细分");
assert.equal(piTooOld(null), true, "没找到 pi 也算不够");

// ---------------------------------------------------------------- 来源

assert.equal(bareSource("npm:@juicesharp/rpiv-ask-user-question@2.15.0"), "npm:@juicesharp/rpiv-ask-user-question");
assert.equal(bareSource("npm:@juicesharp/rpiv-ask-user-question"), "npm:@juicesharp/rpiv-ask-user-question", "作用域里的 @ 不是版本");
assert.equal(bareSource("npm:pi-web-access@^0.47.0"), "npm:pi-web-access");
assert.equal(bareSource("npm:pi-subagents@latest"), "npm:pi-subagents");
assert.equal(bareSource("npm:pi-subagents"), "npm:pi-subagents");
assert.equal(bareSource("..\\packages\\pi-tui"), "..\\packages\\pi-tui", "本地路径原样");
assert.equal(bareSource("git+https://example.com/x.git@v1.2.3"), "git+https://example.com/x.git");

// 来源本身指向哪个包名：git / 本地路径装的同名包也要认得出来（不然会再装一份 npm 版）。
assert.equal(sourceName("npm:@juicesharp/rpiv-ask-user-question@2.15.0"), "@juicesharp/rpiv-ask-user-question");
assert.equal(sourceName("npm:pi-subagents"), "pi-subagents");
assert.equal(sourceName("git:github.com/someone/pi-subagents@v0.86.0"), "pi-subagents");
assert.equal(sourceName("https://github.com/someone/pi-subagents.git"), "pi-subagents");
assert.equal(sourceName("..\\packages\\pi-tui"), "pi-tui");
assert.equal(sourceName("/home/me/src/pi-web-access/"), "pi-web-access");

// 写了版本的就是下限，不写的原样。
const subagents = REQUIRED_PACKAGES.find((p) => p.name === "pi-subagents");
const webAccess = REQUIRED_PACKAGES.find((p) => p.name === "pi-web-access");
assert.equal(installSource(subagents), "npm:pi-subagents@0.90.0");
assert.equal(installSource(webAccess), "npm:pi-web-access");
assert.ok(REQUIRED_PACKAGES.every((p) => p.name && p.id), "每条都要有名字和功能 id");
assert.equal(OPTIONAL_PACKAGES.length, 1);
assert.equal(OPTIONAL_PACKAGES[0].name, "billion-context");

// ---------------------------------------------------------------- 跟 pi list 配对

const found = [
  { source: "npm:pi-subagents", name: "pi-subagents", version: "0.90.0" },
  { source: "npm:@juicesharp/rpiv-ask-user-question", name: "@juicesharp/rpiv-ask-user-question", version: "2.15.0" },
  { source: "npm:@juicesharp/rpiv-todo", name: "@juicesharp/rpiv-todo", version: "2.15.0" },
  { source: "npm:pi-web-access", name: "pi-web-access", version: null },
];
const all = depStatus(found);
assert.equal(all.length, 4);
assert.ok(all.every((s) => s.installed));
assert.equal(missingCount(all), 0);
assert.equal(pendingCount(all), 0, "齐了就没有待办：不升不降");
assert.equal(all.find((s) => s.name === "pi-subagents").behind, false);
assert.equal(all.find((s) => s.name === "pi-web-access").behind, false, "不写版本就没有“旧”这回事");
assert.ok(all.every((s) => depAction(s) === "keep"), "齐了就一动不动");

// 装了但低于下限：要升级（不是“提示一下就行”）。
const partial = depStatus([{ source: "npm:pi-subagents", name: "pi-subagents", version: "0.84.0" }]);
assert.equal(missingCount(partial), 3);
const sub = partial.find((s) => s.name === "pi-subagents");
assert.equal(sub.installed, true);
assert.equal(sub.behind, true, "低于下限：低于就是低于，不管差几个版本");
assert.equal(sub.foundVersion, "0.84.0");
assert.equal(depAction(sub), "upgrade");
assert.equal(pendingCount(partial), 4, "3 个缺 + 1 个要升：都得在 npm install 时动");
assert.equal(depAction(partial.find((s) => !s.installed)), "install", "没装就是装，不是升级");

// 比下限新：同样是 keep —— 不降级、也不在页面上提一句“你太新了”。
const newer = depStatus([{ source: "npm:pi-subagents", name: "pi-subagents", version: "0.92.0" }]).find(
  (s) => s.name === "pi-subagents",
);
assert.equal(newer.behind, false);
assert.equal(depAction(newer), "keep");
assert.equal(pendingCount([newer]), 0, "比下限新：没有待办");

// 读了版本但读不出号（package.json 坏了）：不当“旧”，也不动它。
const unknown = depStatus([{ source: "npm:pi-subagents", name: "pi-subagents", version: null }]).find(
  (s) => s.name === "pi-subagents",
);
assert.equal(unknown.installed, true);
assert.equal(unknown.behind, false);
assert.equal(depAction(unknown), "keep");

// 大小写不敏感（npm 包名本来就不区分）。
assert.equal(depStatus([{ source: "npm:Pi-Subagents", name: "Pi-Subagents", version: "0.90.0" }])[0].installed, true);

// ---------------------------------------------------------------- pi list 的文本

// 真 `pi list` 的形状（没有 --json）：`User packages:`，来源缩进两格、路径缩进四格。
// 路径得是真的（解析器会 fs.existsSync 一下），所以在系统临时目录里摆三个假包。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deps-"));
const fake = (dir, name, version) => {
  const full = path.join(home, dir);
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(full, "package.json"), JSON.stringify({ name, version }));
  return full;
};
const dirSub = fake("pi-subagents", "pi-subagents", "0.90.0");
const dirAsk = fake(path.join("@juicesharp", "rpiv-ask-user-question"), "@juicesharp/rpiv-ask-user-question", "2.15.0");
const dirTodo = fake(path.join("@juicesharp", "rpiv-todo"), "@juicesharp/rpiv-todo", "2.15.0");
const listText = `User packages:
  npm:pi-subagents
    ${dirSub}
  npm:@juicesharp/rpiv-ask-user-question@2.15.0
    ${dirAsk}
  npm:@juicesharp/rpiv-todo@2.15.0
    ${dirTodo}
  npm:pi-web-access`;
const readPkg = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
};
const parsed = statusFromList(listText, readPkg);
assert.equal(parsed.length, 4);
assert.ok(parsed.every((s) => s.installed), "带版本的来源也要认出来");
assert.equal(parsed.find((s) => s.name === "pi-subagents").foundVersion, "0.90.0");
assert.equal(parsed.find((s) => s.name === "@juicesharp/rpiv-ask-user-question").foundVersion, "2.15.0");
assert.equal(parsed.find((s) => s.name === "@juicesharp/rpiv-todo").foundVersion, "2.15.0");
assert.equal(parsed.find((s) => s.name === "pi-web-access").foundVersion, null, "没给路径就是读不到版本，不是没装");

// 只有表头、或者什么都没有：三个都算缺（不能因为输出像样就以为装上了）。
assert.equal(statusFromList("User packages:", readPkg).filter((s) => s.installed).length, 0);
assert.equal(statusFromList("", readPkg).length, 4);

// git / 本地路径装的：包名读它自己的 package.json，读不到按来源猜 —— 都算已装。
const dirGit = fake("git-sub", "pi-subagents", "0.85.0");
const gitList = `User packages:
  git:github.com/someone/pi-subagents
    ${dirGit}
  ..\\packages\\pi-web-access`;
const gitParsed = statusFromList(gitList, readPkg);
assert.equal(gitParsed.find((s) => s.name === "pi-subagents").installed, true, "git 来源装的也算");
assert.equal(gitParsed.find((s) => s.name === "pi-subagents").foundVersion, "0.85.0");
assert.equal(gitParsed.find((s) => s.name === "pi-web-access").installed, true, "本地路径装的（没有 package.json 可读）按末段名认");

// 只装在某个工程里的（Project packages）不算：清单约定装到用户全局。
const projectOnly = `Project packages:
  npm:pi-subagents
    ${dirSub}`;
assert.equal(statusFromList(projectOnly, readPkg).find((s) => s.name === "pi-subagents").installed, false);
assert.equal(foundPackages([{ scope: "project", source: "npm:x", path: null }], readPkg).length, 0);
fs.rmSync(home, { recursive: true, force: true });

assert.equal(bootstrapCommand(), "node scripts/bootstrap.mjs");

// ---------------------------------------------------------------- 三份 README 的表抄得对不对

for (const lang of ["README.md", "README.en.md", "README.ja.md"]) {
  const readme = fs.readFileSync(path.join(import.meta.dirname, "..", "..", lang), "utf8");
  assert.ok(readme.includes(`pi ≥ ${MIN_PI_VERSION}`), `${lang} 要写 pi ≥ ${MIN_PI_VERSION}`);
  for (const pkg of REQUIRED_PACKAGES) {
    const row = readme.split(/\r?\n/).find((line) => line.startsWith(`| \`${pkg.name}\``));
    assert.ok(row, `${lang} 的表里缺 ${pkg.name}`);
    assert.ok(row.includes(pkg.version ?? "latest"), `${lang} 里 ${pkg.name} 的版本跟 deps.ts 不一致：${row}`);
  }
}

// ---------------------------------------------------------------- 真样本跟下限绑在一起

// `bridge/tests/fixtures/pi-subagents-<版本>/` 是网页解析的那堆文件的真实样本（D393）。
// 版本对不上就是「换了钉子却忘了重取样本」——在单测里红，而不是在用户机器上静默读不到。
const fixtures = path.join(import.meta.dirname, "fixtures");
const subFixture = fs
  .readdirSync(fixtures)
  .filter((dir) => dir.startsWith("pi-subagents-"))
  .sort()
  .pop();
assert.ok(subFixture, "要有一份 pi-subagents 的真样本（fixtures/pi-subagents-*/README.md 说了怎么取）");
const fxMeta = JSON.parse(fs.readFileSync(path.join(fixtures, subFixture, "meta.json"), "utf8"));
assert.equal(fxMeta.package, "pi-subagents");
assert.equal(fxMeta.version, subagents.version, `样本是 ${fxMeta.version}、清单要求 ${subagents.version}：换下限时重取样本`);
assert.equal(subFixture, `pi-subagents-${fxMeta.version}`, "目录名要带版本，不然分不清哪份样本属于哪一版");

console.log("deps-unit: ok");
