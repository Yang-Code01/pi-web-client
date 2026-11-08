/**
 * 隐式触发：pi 没有 Skill 工具 —— 系统提示词里只有 <available_skills> 清单，模型「用」一个技能的唯一动作
 * 是把那份 SKILL.md `read` 进来。所以判定只有一条：read 的 `path` 正好是某个技能的 SKILL.md。
 * 卡片要在那张 read 之前、一轮一个技能一张，理由取「它读之前说的那句」，没说话就退回本轮用户消息。
 *
 *   node bridge/tests/skill-implicit.mjs        (Node ≥ 22.18 strips the .ts types itself)
 */
import assert from "node:assert/strict";
import path from "node:path";
import { entriesToItems, skillItemFor, withSkillItems } from "../src/items.ts";
import { frontmatter, skillOfRead } from "../src/skills.ts";

let n = 0;
const ok = (msg) => console.log(`  ok ${++n}  ${msg}`);

const ROOT = "C:\\Users\\GG_Bond\\.pi\\agent\\skills";
const SKILL = {
  name: "anatomy",
  description: "把技术概念画成等距 SVG 的机械装置。",
  source: "user",
  uses: 0,
  lastUsed: 0,
  path: path.join(ROOT, "anatomy"),
  root: ROOT,
  link: false,
  removable: true,
};
const OTHER = { ...SKILL, name: "grilling", path: path.join(ROOT, "grilling"), description: "把计划拷问到站不住的地方。" };
const SKILLS = [SKILL, OTHER];
const SKILL_MD = path.join(SKILL.path, "SKILL.md");

// ---------------------------------------------------------------- 判定
assert.equal(skillOfRead(SKILLS, "read", { path: SKILL_MD })?.name, "anatomy");
ok("read 指到 SKILL.md → 命中");

assert.equal(skillOfRead(SKILLS, "read", { path: SKILL_MD.replace(/\\/g, "/") })?.name, "anatomy");
ok("正斜杠的同一路径也算命中（Windows 上模型两种都会写）");

assert.equal(skillOfRead(SKILLS, "read", { path: path.join(SKILL.path, "README.md") }), undefined);
ok("同一个技能目录里的别的文件不算：只有 SKILL.md 才是加载");

assert.equal(skillOfRead(SKILLS, "bash", { path: SKILL_MD }), undefined);
ok("bash cat 进来的 SKILL.md 不标 —— 参数里那只是命令行，不是路径");

assert.equal(skillOfRead(SKILLS, "read", { path: "C:\\elsewhere\\SKILL.md" }), undefined);
ok("不在清单里的 SKILL.md 不算");

// read 的相对路径按会话 cwd 解（pi 的 read 就是这么解的），不按桥进程的 cwd
assert.equal(skillOfRead(SKILLS, "read", { path: path.join("anatomy", "SKILL.md") }, ROOT)?.name, "anatomy");
ok("相对路径 + cwd → 仍命中");

// 带 BOM / 开头多一个空行的 SKILL.md 也是合法技能，别让描述退成空
assert.equal(frontmatter("\uFEFF---\nname: anatomy\ndescription: 好\n---\n").description, "好");
assert.equal(frontmatter("\n\n---\nname: anatomy\ndescription: 也好\n---\n").description, "也好");
ok("BOM / 开头空行不影响 frontmatter");

// ---------------------------------------------------------------- 插卡
const user = { id: "u1", kind: "user", text: "画一张等距图，讲讲 bridge 和 pi 怎么分工。", images: [] };
const said = { id: "a1", kind: "assistant", text: "先按等距图的规矩来。", thinking: "" };
const read = (id, p) => ({ id, kind: "tool", toolCallId: id, name: "read", args: { path: p }, status: "ok" });

const items = withSkillItems([user, said, read("t1", SKILL_MD), read("t2", "F:\\pi-web-client\\bridge\\src\\runtime.ts"), read("t3", SKILL_MD)], SKILLS);
const cards = items.filter((it) => it.kind === "skill");
assert.equal(cards.length, 1);
ok("同一个 SKILL.md 读两遍，一轮只画一张卡");

const card = cards[0];
assert.equal(card.name, "anatomy");
assert.equal(card.description, SKILL.description);
assert.equal(card.why, "先按等距图的规矩来。");
assert.equal(card.whyFrom, "model");
assert.equal(card.path, SKILL_MD);
assert.equal(items.indexOf(card), 2);
ok("卡落在那个 read 之前（ops 模块在客户端收到第一张工具卡时才建，所以卡在模块上面）");

// 一轮一个：新的 user 之后同名技能可以再画一次
const two = withSkillItems([user, said, read("t1", SKILL_MD), { id: "u2", kind: "user", text: "再来一张。", images: [] }, read("t4", SKILL_MD)], SKILLS);
assert.deepEqual(two.filter((it) => it.kind === "skill").map((it) => it.why), ["先按等距图的规矩来。", "再来一张。"]);
ok("下一轮说了新话：新的一张卡，理由换成这一轮的话（旧那句不能被拿来当新线索）");

// ---------------------------------------------------------------- 回放：真会话文件的样子
const entries = [
  { type: "message", id: "e1", timestamp: "2026-11-08T04:00:00.000Z", parentId: null, message: { role: "user", content: [{ type: "text", text: "画一张等距图。" }] } },
  {
    type: "message",
    id: "e2",
    timestamp: "2026-11-08T04:00:01.000Z",
    parentId: "e1",
    message: { role: "assistant", model: "m", content: [{ type: "text", text: "" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: SKILL_MD } }] },
  },
  { type: "message", id: "e3", timestamp: "2026-11-08T04:00:02.000Z", parentId: "e2", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "# anatomy" }] } },
];
const replay = withSkillItems(entriesToItems(entries), SKILLS);
const replayCard = replay.find((it) => it.kind === "skill");
assert.equal(replayCard?.why, "画一张等距图。");
assert.equal(replayCard?.whyFrom, "user");
assert.equal(replayCard?.id, "e2:c1:skill");
ok("老会话回放：模型一句没说，理由退回本轮用户消息（whyFrom=user）");

assert.equal(withSkillItems(entriesToItems(entries), []).some((it) => it.kind === "skill"), false);
ok("没有技能清单（或 cwd 为空）时什么都不插，绝不瞎标");

// ---------------------------------------------------------------- 实时：调用点自己算卡
const live = [{ id: "a1", kind: "assistant", text: "先看一眼 anatomy 的规矩。", thinking: "" }];
const liveCard = skillItemFor(live, SKILLS, { name: "read", args: { path: SKILL_MD } });
assert.equal(liveCard?.whyFrom, "model");
assert.equal(liveCard?.why, "先看一眼 anatomy 的规矩。");
live.push(liveCard);
assert.equal(skillItemFor(live, SKILLS, { name: "read", args: { path: SKILL_MD } }), undefined);
ok("实时：本轮已有同名卡就返回 undefined（不重复画）");

// 多步轮次：先说话，再来一条只有工具调用、正文为空的 assistant 消息 —— 理由仍取它说的那句，
// 而且回放给的就是实时那张卡（刷新不换词）。
const entries2 = [
  { type: "message", id: "u1", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "把这批页面按 anatomy 的规矩画一下。" }] } },
  { type: "message", id: "a1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "先看一眼 anatomy 的规矩。" }] } },
  { type: "message", id: "a2", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "t9", name: "read", arguments: { path: SKILL_MD } }] } },
];
const stepsCard = withSkillItems(entriesToItems(entries2), SKILLS).find((it) => it.kind === "skill");
assert.equal(stepsCard?.whyFrom, "model");
assert.equal(stepsCard?.why, "先看一眼 anatomy 的规矩。");
ok("多步轮次：自己那句当线索，实时与回放同一张卡");

console.log(`\n${n} checks passed`);
