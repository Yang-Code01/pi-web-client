/**
 * A `/skill:x` prompt reaches the session file already expanded by pi
 * (`<skill name="x" location="…">the whole SKILL.md</skill> args`). Everything the web client shows
 * — the bubble, the copy button, the fork fallback in branchOff, the rail label, the queue — must
 * read as the command the human typed. `displayUserText` / `normalizeUserText` are the one place
 * that knows how to fold it back; `web/src/skill.ts` mirrors the rule for the not-yet-written copy.
 *
 *   node bridge/tests/skill-block.mjs        (Node ≥ 22.18 strips the .ts types itself)
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { displayUserText, normalizeUserText, skillExpansion, titleFromUserText, typedSkill } from "../src/sessionfile.ts";
import { entriesToItems } from "../src/items.ts";
import { skillOf } from "../../web/src/skill.ts";

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

// 3. `location` is optional: older files (or hand-written ones) may lack it, and an empty string
//    would make the chip claim a path it does not have.
const noLocation = BLOCK.replace(` location="${LOCATION}"`, "");
assert.equal(skillExpansion(noLocation).location, undefined);
assert.equal(displayUserText(noLocation), "/skill:grill-me");
ok("missing location still folds, and the item carries no skillPath");

// 4. Everything that is not a leading skill block is returned byte for byte. A `<skill>` without a
//    name is nothing we can fold back — it stays as stored rather than becoming `/skill:`.
for (const raw of [
  "普通消息",
  "",
  '```\n<skill name="x"></skill>\n```',
  '前面有字 <skill name="x">a</skill>',
  "<skill>no name</skill>",
]) {
  assert.equal(displayUserText(raw), raw);
}
// Leading whitespace is tolerated (the block is still the first thing in the message).
assert.equal(displayUserText(`  ${BLOCK}\n\n看看`), "/skill:grill-me 看看");
ok("only a leading, named skill block folds; anything else is untouched (identity)");

// 5. A SKILL.md may quote `</skill>` while explaining this very format: the body is greedy on
//    purpose, so the fold must not stop at the quoted one and eat the rest of the document.
const quoted = BLOCK.replace('Call the Skill tool with "grilling".', '调用写成 `<skill name="x">…</skill>` 这样。');
assert.equal(displayUserText(`${quoted}\n\n真的 args`), "/skill:grill-me 真的 args");
ok("a `</skill>` inside the document does not truncate the fold");

// 6. pi owns that opening tag: extra or reordered attributes must not put the SKILL.md back on screen.
const reordered = `<skill location="${LOCATION}" name="grill-me" version="2">\nbody\n</skill>`;
assert.equal(displayUserText(reordered), "/skill:grill-me");
ok("attribute order and extra attributes do not matter");

// 7. Folding twice changes nothing: the fork path may hand us already-folded text.
assert.equal(displayUserText(displayUserText(withArgs)), displayUserText(withArgs));
ok("displayUserText is idempotent");

// 8. Sidebar titles keep their previous behaviour (collapse whitespace, 120-char cap).
assert.equal(titleFromUserText(BLOCK), "/skill:grill-me");
assert.equal(titleFromUserText(withArgs), "/skill:grill-me 看看 #72");
assert.equal(titleFromUserText("  多   行\n标题 "), "多 行 标题");
assert.equal(titleFromUserText(""), null);
assert.equal(titleFromUserText("x".repeat(200)).length, 120);
ok("titleFromUserText: same fold, collapsed, capped at 120");

// 9. Transcript items: the bubble text is the command, the item carries the name for the chip and
//    the path for its tooltip; a plain message gains neither key.
const entry = (id, parentId, content) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-11-07T03:05:31.000Z",
  message: { role: "user", content: Array.isArray(content) ? content : [{ type: "text", text: content }] },
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

const noPath = entriesToItems([entry("u3", null, noLocation)])[0];
assert.equal(noPath.text, "/skill:grill-me");
assert.equal("skillPath" in noPath, false);
ok("folded item without location omits skillPath");

// 10. An attached image appends `[图片]` to `contentText`; that is not user prose and must not end
//     up as the command's args (the bubble draws its own 「附 N 张图片」 notice).
const withImage = entriesToItems([entry("u4", null, [{ type: "text", text: withArgs }, { type: "image", mimeType: "image/png" }])])[0];
assert.equal(withImage.text, "/skill:grill-me 看看 #72");
assert.equal(withImage.images.length, 1);
assert.equal(withImage.skill, "grill-me");
ok("an image placeholder never becomes part of the folded command");

// 11. The fork fallback in branchOff compares display text: the web sends the folded command back
//     while the file still holds the block, so a byte comparison would throw 「找不到这条消息」.
assert.notEqual(withArgs.replace(/\s+/g, " ").trim(), "/skill:grill-me 看看 #72");
assert.equal(normalizeUserText(withArgs), normalizeUserText("/skill:grill-me 看看 #72"));
assert.equal(normalizeUserText("/skill:grill-me\t\t看看   #72"), normalizeUserText(withArgs));
assert.equal(normalizeUserText("普通   消息"), "普通 消息");
ok("branchOff / queue match on display text, not on the stored bytes");

// 12. The optimistic bubble (before the file catches up) is marked from the typed text too, so a
//     `/skill:x` send does not swap styles when pi's expanded copy lands ~400 ms later.
assert.equal(typedSkill("/skill:grill-me 看看 #72"), "grill-me");
assert.equal(typedSkill("/skill:grill-me"), "grill-me");
assert.equal(typedSkill("普通消息"), null);
assert.equal(typedSkill("看 /skill:x"), null);
ok("typedSkill marks the optimistic bubble, only at the start");

// 13. The web side asks the same question (`skillOf`, which feeds both the composer's optimistic
//     bubble and the skill-usage counter) — the two builds cannot share a module, so compare.
for (const t of ["/skill:grill-me", "  /skill:grill-me 看看", "普通消息", "看 /skill:x", "/skill:"]) {
  assert.equal(skillOf(t), typedSkill(t));
}
ok("web skillOf agrees with the bridge's typedSkill");

console.log(`\n${n} checks passed (${path.basename(fileURLToPath(import.meta.url))})`);
