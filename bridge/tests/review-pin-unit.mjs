/**
 * 「评审仓库」的钉子：会话目录下面那个子仓库记在哪、认不出来时怎么回落。
 *
 * 这层的价值全在**回落**：钉子指向的目录被删了、或者被人改成了一个不是仓库的目录，
 * 面板必须老老实实回到会话目录并说「这里不是仓库」，而不是拿一个不存在的路径去评、
 * 或者把上一个仓库的记录当成这个仓库的。写错这一条，用户看到的是「结论正常、其实全是别人的」。
 *
 *   node --experimental-strip-types bridge/tests/review-pin-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.PI_WEB_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-review-pin-"));

const { effectiveReviewDir, readReviewPin, repoKey, reviewDir, reviewPinFile, sessionKey, setReviewPin } = await import("../src/review.ts");

/** 账号 / 8.3 短名两边的写法不一样（`os.tmpdir()` 给短名、git 给长名），一律先 realpath 再比。 */
const sameDir = (a, b) => {
  const norm = (p) => {
    try {
      return fs.realpathSync.native(p).toLowerCase();
    } catch {
      return path.resolve(p).toLowerCase();
    }
  };
  return norm(a) === norm(b);
};
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
/** 一个空仓库（不需要提交：`rev-parse --show-toplevel` 在没提交的仓库上也答得出）。 */
const repo = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  return dir;
};
const plain = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-pin-dirs-"));
const big = plain(path.join(workspace, "big"));
const sub = repo(path.join(big, "erp", "api"));
const bigRepo = repo(path.join(workspace, "solid"));

// ---- 没有钉子：用的就是会话目录自己（这一层是仓库时）
{
  const out = effectiveReviewDir(bigRepo, "s-none");
  assert.equal(out.pinned, "");
  assert.ok(sameDir(out.repo, bigRepo), `repo 应该是会话目录：${out.repo}`);
  assert.equal(readReviewPin("s-none"), "", "没写过钉子就该是空串");
}

// ---- 钉子文件落在 review/pins/<session>.json，内容是 {dir}
{
  const at = setReviewPin(sub, "s-a");
  assert.ok(sameDir(at, sub));
  assert.equal(reviewPinFile("s-a"), path.join(reviewDir(), "pins", `${sessionKey("s-a")}.json`));
  const raw = JSON.parse(fs.readFileSync(reviewPinFile("s-a"), "utf8"));
  assert.ok(sameDir(String(raw.dir), sub), `盘上记的是那个目录：${raw.dir}`);
  assert.ok(sameDir(readReviewPin("s-a"), sub));
  // 钉子的位置不能跟「评审状态」混在一起：状态是按 repoKey 分的，一个会话可以评两个仓库。
  assert.ok(!reviewPinFile("s-a").includes(repoKey(sub)), "钉子不许塞进某个仓库的状态目录里");
}

// ---- 有钉子：有效目录 = 钉住的仓库，且归一成仓库根（不是它的子目录）
{
  const nested = plain(path.join(sub, "src", "deep"));
  const at = setReviewPin(nested, "s-a");
  assert.ok(sameDir(at, nested), "setReviewPin 只做 resolve，归一在桥的消息处理里");
  const out = effectiveReviewDir(big, "s-a");
  assert.ok(sameDir(out.repo, sub), `有效目录应该是子仓库根：${out.repo}`);
  assert.ok(sameDir(out.pinned, sub), "回报的钉子也要是归一后的仓库根");
  // 盘上留的是用户给的那个路径（桥上收到 `review.pin` 时先 `gitRoot` 再写，所以正常情形已是根）；
  // 这里钉的是子目录，读回来还是那个子目录 —— 归一发生在「算有效目录」这一步。
  assert.ok(sameDir(readReviewPin("s-a"), nested), `盘上应该还是原样的路径：${readReviewPin("s-a")}`);
  // 而有效目录（不管盘上记的是子目录还是根）都是那一个仓库根。
  assert.ok(sameDir(effectiveReviewDir(big, "s-a").repo, sub));
}

// ---- 会话之间互不影响
{
  setReviewPin(sub, "s-a");
  assert.equal(readReviewPin("s-b"), "", "别的会话没有钉子");
  // 没钉子、会话目录又不是仓库：跟以前一样抛 not_git（由帧带 code 回去，面板说清楚并给「选一个仓库」）。
  assert.throws(
    () => effectiveReviewDir(big, "s-b"),
    (err) => err.code === "not_git",
    "没钉子时不许偷偷选一个",
  );
}

// ---- 清钉子：写空串 = 删文件
{
  setReviewPin(sub, "s-c");
  assert.ok(fs.existsSync(reviewPinFile("s-c")));
  const at = setReviewPin("", "s-c");
  assert.equal(at, "");
  assert.equal(fs.existsSync(reviewPinFile("s-c")), false, "清钉子要真把文件删掉");
  assert.equal(readReviewPin("s-c"), "");
}

// ---- 钉子指向一个不是仓库的目录：回落会话目录，并把钉子清掉（别每次打开都再失败一次）
{
  const notRepo = plain(path.join(workspace, "notes"));
  setReviewPin(notRepo, "s-d");
  const out = effectiveReviewDir(bigRepo, "s-d");
  assert.ok(sameDir(out.repo, bigRepo), `应该回到会话目录：${out.repo}`);
  assert.equal(out.pinned, "", "失效的钉子不能回报");
  assert.equal(readReviewPin("s-d"), "", "失效的钉子要清掉");
}

// ---- 钉子指向的目录被删了：同样回落 + 清钉子
{
  const gone = repo(path.join(workspace, "gone"));
  setReviewPin(gone, "s-e");
  fs.rmSync(gone, { recursive: true, force: true });
  const out = effectiveReviewDir(bigRepo, "s-e");
  assert.ok(sameDir(out.repo, bigRepo), `目录没了也要回落：${out.repo}`);
  assert.equal(readReviewPin("s-e"), "");
}

// ---- 会话目录自己也不是仓库、钉子也失效：钉子清掉、照旧抛 not_git（一边回落一边说清楚）
{
  setReviewPin(plain(path.join(workspace, "junk")), "s-f");
  assert.throws(
    () => effectiveReviewDir(big, "s-f"),
    (err) => err.code === "not_git",
  );
  assert.equal(readReviewPin("s-f"), "", "失效的钉子不能留着");
}

// ---- 坏文件：当成没钉子，不抛
{
  fs.mkdirSync(path.dirname(reviewPinFile("s-g")), { recursive: true });
  fs.writeFileSync(reviewPinFile("s-g"), "{ 这不是 json");
  assert.equal(readReviewPin("s-g"), "");
  const out = effectiveReviewDir(bigRepo, "s-g");
  assert.ok(sameDir(out.repo, bigRepo));
}

// ---- 没会话（sessionId 空）：钉子落在 `_nosession` 上，且不许盖掉别的会话
{
  // 先给有会话的放一个**不同**的钉子：两边共用一个文件的话，下面那句会被它自己的写入盖掉。
  setReviewPin(bigRepo, "s-a");
  setReviewPin(sub, "");
  assert.equal(sessionKey(""), "_nosession");
  assert.equal(reviewPinFile(""), path.join(reviewDir(), "pins", "_nosession.json"));
  assert.notEqual(reviewPinFile(""), reviewPinFile("s-a"), "空会话要有自己的文件");
  assert.ok(sameDir(readReviewPin(""), sub), `空会话记的是它自己的钉子：${readReviewPin("")}`);
  assert.ok(sameDir(readReviewPin("s-a"), bigRepo), `写空会话的钉子不许盖掉别的会话：${readReviewPin("s-a")}`);
  setReviewPin("", "");
  setReviewPin("", "s-a");
}

console.log("review-pin-unit: ok");
