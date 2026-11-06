/**
 * A `/skill:x` prompt reaches the session file already expanded by pi
 * (`<skill name="x" location="…">the whole SKILL.md</skill> args`). Everything the web client shows
 * — the bubble, the copy button, the fork fallback in branchOff, the rail label — must read as the
 * command the human typed. `displayUserText` is the one place that knows how to fold it back.
 *
 *   node bridge/tests/skill-block.mjs        (Node ≥ 22.18 strips the .ts types itself)
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { displayUserText, skillExpansion, titleFromUserText, typedSkill } from "../src/sessionfile.ts";
import { entriesToItems } from "../src/items.ts";

void fileURLToPath; // keeps the import shape of the other tests (`node:url` is used there for paths)

let n = 0;
const ok = (msg) => console.log(`  ok ${++n}  ${msg}`);

const LOCATION = "C:\\Users\\GG_Bond\\.pi\\agent\\skills\\grill-me\\SKILL.md";
/** Exactly what pi writes for `/skill:grill-me` (sample copied from a real session file). */
const BLOCK = [
  `<skill name="grill-me" location="${LOCATION}">`,
  "References are relative to C:\\Users\\GG_Bond\\.pi\\agent\\skills\\grill-me.",
  "",
  'Call the Skill tool with "grilling".',
  "</skill>",
].join("\n");

// 1. No args: just the command.
const bare = skillExpansion(BLOCK);
assert.equal(bare.name, "grill-me");
assert.equal(bare.location, LOCATION);
assert.equal(bare.args, "");
assert.equal(bare.command, "/skill:grill-me");
ok("expanded block, no args -> /skill:grill-me");

// 2. Args after a blank line (pi joins them with \n\n) come back as one line of text.
const withArgs = `${BLOCK}\n\n看看 #72`;
assert.equal(displayUserText(withArgs), "/skill:grill-me 看看 #72");
ok("args survive the fold, outer whitespace trimmed");

// 3. `location` is optional in the parser: older files (or hand-written ones) may lack it.
const noLocation = BLOCK.replace(` location="${LOCATION}"`, "");
assert.equal(skillExpansion(noLocation).location, "");
assert.equal(displayUserText(noLocation), "/skill:grill-me");
ok("missing location attribute still folds");

// 4. Everything that is not a leading skill block is returned byte for byte.
for (const raw of ["普通消息", "", "```\n<skill name=\"x\"></skill>\n```", "前面有字 <skill name=\"x\">a</skill>"]) {
  assert.equal(displayUserText(raw), raw);
}
// Leading whitespace is tolerated (the block is still the first thing in the message).
assert.equal(displayUserText(`  ${BLOCK}\n\n看看`), "/skill:grill-me 看看");
ok("only a leading skill block folds; anything else is untouched (identity)");

// 5. Folding twice changes nothing: the fork path may hand us already-folded text.
assert.equal(displayUserText(displayUserText(withArgs)), displayUserText(withArgs));
ok("displayUserText is idempotent");

// 6. Sidebar titles keep their previous behaviour (collapse whitespace, 120-char cap).
assert.equal(titleFromUserText(BLOCK), "/skill:grill-me");
assert.equal(titleFromUserText(withArgs), "/skill:grill-me 看看 #72");
assert.equal(titleFromUserText("  多   行\n标题 "), "多 行 标题");
assert.equal(titleFromUserText(""), null);
assert.equal(titleFromUserText("x".repeat(200)).length, 120);
ok("titleFromUserText: same fold, collapsed, capped at 120");

// 7. Transcript items: the bubble text is the command, the item carries the name for the chip and
//    the path for its tooltip; a plain message gains neither key.
const entry = (id, parentId, text) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-11-07T03:05:31.000Z",
  message: { role: "user", content: [{ type: "text", text }] },
});
const assistant = {
  type: "message",
  id: "a1",
  parentId: "u1",
  timestamp: "2026-11-07T03:05:40.000Z",
  message: { role: "assistant", content: [{ type: "text", text: "好" }], model: "deepseek-v4.1-flash" },
};
const items = entriesToItems([entry("u1", null, withArgs), assistant]);
assert.equal(items[0].kind, "user");
assert.equal(items[0].text, "/skill:grill-me 看看 #72");
assert.equal(items[0].skill, "grill-me");
assert.equal(items[0].skillPath, LOCATION);
assert.equal(items[1].kind, "assistant");
assert.equal(items[1].text, "好");
ok("entriesToItems folds the user message and marks it");

const plain = entriesToItems([entry("u2", null, "我输入的普通消息")])[0];
assert.equal(plain.text, "我输入的普通消息");
assert.equal("skill" in plain, false);
assert.equal("skillPath" in plain, false);
ok("plain user message carries no skill keys");

// 8. The fork fallback in branchOff compares display text: the web sends the folded command back
//    while the file still holds the block, so a byte comparison would throw 「找不到这条消息」.
const norm = (t) => displayUserText(t).replace(/\s+/g, " ").trim();
assert.notEqual(withArgs.replace(/\s+/g, " ").trim(), "/skill:grill-me 看看 #72");
assert.equal(norm(withArgs), norm("/skill:grill-me 看看 #72"));
assert.equal(norm("/skill:grill-me\t\t看看   #72"), norm(withArgs));
ok("branchOff fallback matches on display text, not on the stored bytes");

// 10. The optimistic bubble (before the file catches up) is marked from the typed text too, so a
//     `/skill:x` send does not swap styles when pi's expanded copy lands ~400 ms later.
assert.equal(typedSkill("/skill:grill-me 看看 #72"), "grill-me");
assert.equal(typedSkill("/skill:grill-me"), "grill-me");
assert.equal(typedSkill("普通消息"), null);
assert.equal(typedSkill("看 /skill:x"), null);
ok("typedSkill marks the optimistic bubble, only at the start");

console.log(`\n${n} checks passed (${path.basename(fileURLToPath(import.meta.url))})`);
