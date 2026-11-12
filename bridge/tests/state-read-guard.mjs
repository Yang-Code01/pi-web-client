/**
 * H2：状态文件「读不到」不能当成「是空的」再写回。
 *
 * `readJson` 把「文件不存在」和「读失败 / 解析失败」揉成同一个 fallback。只读的调用方无所谓，
 * 但 pin/order（manage.json）、工作区（workspaces.json）、记录（bug-notes.json）、失败账本
 * （failures/*.json）都是读-改-写：一次瞬时读失败（EBUSY、EACCES、写到一半被截断）就会拿空状态
 * 覆盖盘上的真数据，而且不可逆。
 *
 * 这里给每个存储都塞一份「坏文件」，调一次会落盘的操作，断言文件一个字都没变；再给一份不存在的
 * 文件（首次运行），断言照常写得进去。
 *
 *   node --experimental-transform-types bridge/tests/state-read-guard.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-"));
process.env.PI_WEB_STATE = STATE;

const { readJsonChecked, statePath } = await import("../src/paths.ts");
const { Manage } = await import("../src/manage.ts");
const { Workspaces } = await import("../src/workspaces.ts");
const { notesFile, listNotes, saveNote } = await import("../src/notes.ts");
const { fileFor, readLedger, mergeFailures } = await import("../src/failures.ts");

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${err?.message ?? err}`);
  }
};

const BAD = '{"half": [1, 2'; // 写到一半的 JSON
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

/** 直接问生产端要路径：复刻哈希算法等于给测试埋一条「生产改名就失效」的暗雷。 */
const ledgerFile = fileFor;

// 0. readJsonChecked 自己的语义 -------------------------------------------
check("readJsonChecked：文件不存在 = 首次运行，不是错误", () => {
  const res = readJsonChecked(path.join(STATE, "nope.json"), { a: 1 });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, { a: 1 });
});
check("readJsonChecked：正常文件给出内容", () => {
  const file = put(path.join(STATE, "good.json"), '{"a":2}');
  const res = readJsonChecked(file, {});
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, { a: 2 });
});
check("readJsonChecked：坏文件 ok=false 且带原因", () => {
  const file = put(path.join(STATE, "bad.json"), BAD);
  const res = readJsonChecked(file, {});
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

// 1. manage.json ----------------------------------------------------------
check("manage：读失败时不回写", () => {
  const file = put(statePath("manage.json"), BAD);
  const manage = new Manage();
  manage.pinLast("s1");
  assert.equal(read(file), BAD);
  assert.deepEqual(manage.snapshot().pin, ["s1"], "内存里照旧生效，只是不落盘");
});
check("manage：没有文件（首次运行）照常写", () => {
  fs.rmSync(statePath("manage.json"), { force: true });
  new Manage().pinLast("s1");
  const saved = JSON.parse(read(statePath("manage.json")));
  assert.deepEqual(saved.pin, ["s1"]);
});
check("manage：文件修好后，排队的改动叠在盘上内容之上", () => {
  const file = put(statePath("manage.json"), BAD);
  const manage = new Manage();
  manage.setArchived(["gone"], true);
  assert.equal(read(file), BAD, "读不到就一直不落盘");
  put(file, JSON.stringify({ pin: ["a"], order: ["a", "b"], archived: ["b"] }));
  manage.pinLast("c");
  const saved = JSON.parse(read(file));
  assert.deepEqual(saved.archived, ["b", "gone"], "盘上的归档保留，排队的那次归档补上");
  assert.deepEqual(saved.pin, ["a", "c"]);
  assert.deepEqual(saved.order, ["a"], "归档胜出：排队的那次归档把 b 从 order 里也剔掉了");
});

// 2. workspaces.json ------------------------------------------------------
check("workspaces：读失败时不回写", () => {
  const file = put(statePath("workspaces.json"), BAD);
  const ws = new Workspaces();
  ws.create("客户 A");
  assert.equal(read(file), BAD);
  assert.equal(ws.snapshot().groups.length, 1);
});
check("workspaces：文件修好后，下一次写把排队的改动叠在盘上内容之上", () => {
  const file = put(statePath("workspaces.json"), BAD);
  const ws = new Workspaces();
  ws.create("排队的组");
  assert.equal(read(file), BAD);
  put(
    file,
    JSON.stringify({
      groups: [{ id: "g1", name: "旧组", key: "F:/old", manual: false }],
      overrides: {},
      keys: {},
      pinned: ["g1"],
      max: 2,
    }),
  );
  ws.create("第二组");
  const saved = JSON.parse(read(file));
  assert.equal(saved.groups.length, 3, "旧组 + 排队的组 + 新组");
  assert.deepEqual(
    saved.groups.map((g) => g.name),
    ["旧组", "排队的组", "第二组"],
  );
  // #173 之后 `pinned` 退役、迁成 `order`：旧文件的固定顺序要原样打头。
  assert.equal(saved.order[0], "g1", "盘上旧 pinned 迁进 order 后仍打头");
  assert.equal(saved.pinned, undefined, "不再回写退役的 pinned 字段");
  assert.equal(saved.max, 2, "盘上的名额原样保留");
});
check("workspaces：没有文件（首次运行）照常写", () => {
  fs.rmSync(statePath("workspaces.json"), { force: true });
  new Workspaces().create("客户 A");
  const saved = JSON.parse(read(statePath("workspaces.json")));
  assert.equal(saved.groups.length, 1);
});

// 3. bug-notes.json -------------------------------------------------------
check("notes：读失败时不回写，而且告诉调用方没存上", () => {
  const file = put(notesFile(), BAD);
  assert.deepEqual(listNotes(), []);
  assert.throws(() => saveNote({ title: "一条新记录" }), /这次改动没有保存/);
  assert.equal(read(file), BAD);
});
check("notes：没有文件（首次运行）照常写", () => {
  fs.rmSync(notesFile(), { force: true });
  saveNote({ title: "一条新记录" });
  const saved = JSON.parse(read(notesFile()));
  assert.equal(saved.notes.length, 1);
  assert.equal(listNotes()[0].title, "一条新记录");
});

// 4. failures/*.json ------------------------------------------------------
const wsId = "F:/demo/guard";
const hit = {
  ws: wsId,
  sid: "s1",
  sname: "demo",
  at: "2026-11-08T00:00:00.000Z",
  items: [{ key: "build-fail", tool: "bash", cmd: "npm run build", exit: 1, out: "TS2345", why: "", fix: "" }],
};
check("failures：读失败时不回写", () => {
  const file = put(ledgerFile(wsId), BAD);
  assert.deepEqual(readLedger(wsId).entries, []);
  const res = mergeFailures(hit);
  assert.equal(read(file), BAD);
  assert.equal(res.ledger.entries.length, 1, "内存里照旧记账，只是不落盘");
});
check("failures：没有文件（首次运行）照常写", () => {
  fs.rmSync(ledgerFile("F:/demo/fresh"), { force: true });
  mergeFailures({ ...hit, ws: "F:/demo/fresh" });
  const saved = JSON.parse(read(ledgerFile("F:/demo/fresh")));
  assert.equal(saved.entries.length, 1);
});

console.log(failures ? `\n${failures} FAILED` : "\nall ok");
process.exit(failures ? 1 : 0);
