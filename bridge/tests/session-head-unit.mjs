/**
 * 会话开头那条用户消息，不能因为「贴了几张截图」就被整段丢掉。
 *
 * 以前 `loadEntries()` 按**文件字节**留 16 MB 尾巴：一张截图就是 1~2 MB，十几张之后窗口起点
 * 越过文件第一条用户消息，它整条消失 —— 界面上顶部没有气泡、也没有「载入更早」（窗口之前的东西
 * 根本不在内存里），看起来就是「我发的第一句话被删了」。真实案例：70 MB 的会话里 69 MB 是
 * base64，正文只有 1.4 MB。
 *
 * 现在预算算正文：图片的 base64 读进来就抹成空串（像素由 `loadEntryImage()` 现从盘上取）。
 * 这个用例钉住三件事：开头还在、字节确实没带上内存、像素照样取得到。
 *
 *   node --experimental-transform-types bridge/tests/session-head-unit.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEntries, loadEntryImage } from "../src/sessionfile.ts";
import { entriesToItems } from "../src/items.ts";
import { itemsFrame } from "../src/history.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-head-"));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const T = "2026-01-01T00:00:00.000Z";
const sessionRow = { type: "session", version: 3, id: "s", timestamp: T, cwd: dir };
const USER_TEXT = "第一句话：帮我拆一个 Three.js 的页面";
const IMAGE_BYTES = 800 * 1024;

// ---- 真实形状：一条用户消息 + 26 张 800 KB 的截图 = 20.8 MB（超过 16 MB 预算） ----
const bigRows = [
  sessionRow,
  { type: "message", id: "u1", timestamp: T, message: { role: "user", content: [{ type: "text", text: USER_TEXT }] } },
];
for (let i = 0; i < 26; i++) {
  bigRows.push({
    type: "message",
    id: `shot-${i}`,
    timestamp: T,
    message: {
      role: "toolResult",
      toolCallId: `call-${i}`,
      toolName: "bash",
      content: [{ type: "image", data: "A".repeat(IMAGE_BYTES), mimeType: "image/png" }],
    },
  });
}
const bigFile = path.join(dir, "big.jsonl");
fs.writeFileSync(bigFile, bigRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const bigSize = fs.statSync(bigFile).size;

const big = loadEntries(bigFile);
check(`20.8 MB 的截图文件不再截断（${Math.round(bigSize / 1024 / 1024)} MB）`, big.truncated === false);
check("开头那条用户消息还在", big.entries[0]?.id === "u1", `第一条是 ${big.entries[0]?.id}`);
const items = entriesToItems(big.entries);
check("渲染出来的第一条是用户消息，正文没缺", items[0]?.kind === "user" && String(items[0].text).includes("第一句话"));
check("图片条目一张没少", big.entries.filter((e) => String(e.id).startsWith("shot-")).length === 26);

const keptBytes = big.entries.some((e) => (Array.isArray(e.message?.content) ? e.message.content : []).some((p) => p?.type === "image" && p.data !== ""));
check("base64 没被带上内存（data 抹成空串）", keptBytes === false);
const shot0 = big.entries.find((e) => e.id === "shot-0");
check("mimeType 留着（缩略图靠它）", shot0?.message?.content?.[0]?.mimeType === "image/png");
const pixels = await loadEntryImage(bigFile, "shot-7", 0);
check("像素仍然从盘上现取", pixels?.data.length === Buffer.from("A".repeat(IMAGE_BYTES), "base64").length && pixels.mimeType === "image/png");

// ---- 正文自己就超预算：还是从头部丢，报 truncated ----
const textRows = [sessionRow];
for (let i = 0; i < 40; i++) {
  textRows.push({ type: "message", id: `t${i}`, timestamp: T, message: { role: "assistant", content: [{ type: "text", text: "x".repeat(2000) }] } });
}
const textFile = path.join(dir, "text.jsonl");
fs.writeFileSync(textFile, textRows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const cut = loadEntries(textFile, 8 * 1024);
check("正文超预算：标 truncated", cut.truncated === true);
check("正文超预算：留的是尾巴，末条不变", cut.entries.at(-1)?.id === "t39", `末条 ${cut.entries.at(-1)?.id}`);
check("正文超预算：确实丢了头部", cut.entries.length < 40 && cut.entries[0]?.id !== "t0", `${cut.entries.length} 条，首条 ${cut.entries[0]?.id}`);
const contiguity = cut.entries.every((e, i, all) => i === 0 || Number(all[i - 1].id.slice(1)) + 1 === Number(e.id.slice(1)));
check("留下的条目是连续的一段（分支不断）", contiguity);

const small = loadEntries(textFile, 1024 * 1024);
check("预算够时一条不丢", small.truncated === false && small.entries.length === 40);

// ---- 帧上带得出的 truncated：界面才知道要不要说「只载入了最后一段」 ----
check("itemsFrame 把 truncated 带进 history", itemsFrame([], { full: true, truncated: true }).history.truncated === true);
check("没截断时不带这个字段（帧字节与以前一致）", !("truncated" in itemsFrame([]).history));

fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
