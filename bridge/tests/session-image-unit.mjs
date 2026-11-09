/**
 * `loadEntryImage`：按条目 id + 图片序号从会话文件里取原图。
 *
 * 图片字节不在条目元数据里（网页只拿到 mimeType），点开缩略图才按需读 —— 这个函数就是那条路径。
 * 用一条手写 JSONL 钉住：取第 1/2 张、越界、非 message 条目、不存在的 id。
 *
 *   node --experimental-transform-types bridge/tests/session-image-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEntryImage } from "../src/sessionfile.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-image-"));
const file = path.join(dir, "s.jsonl");

// 两个 1×1 PNG（内容不同），足够证明取到的是对应那张而不是缓存/错位。
const PNG_A = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_B = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const b64 = (buf) => buf.toString("base64");
const entry = {
  type: "message",
  id: "entry-with-images",
  timestamp: "2026-01-01T00:00:01.000Z",
  message: {
    role: "user",
    content: [
      { type: "text", text: "看这两张" },
      { type: "image", data: b64(PNG_A), mimeType: "image/png" },
      { type: "image", data: b64(PNG_B), mimeType: "image/webp" },
    ],
  },
};
const rows = [
  { type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir },
  entry,
  { type: "message", id: "text-only", message: { role: "assistant", content: [{ type: "text", text: "收到" }] } },
];
fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const first = await loadEntryImage(file, "entry-with-images", 0);
check("第 1 张：字节与 mime 都对", first?.mimeType === "image/png" && first.data.equals(PNG_A));
const second = await loadEntryImage(file, "entry-with-images", 1);
check("第 2 张：按序号取，不是重复第 1 张", second?.mimeType === "image/webp" && second.data.equals(PNG_B));
check("越界（n=2）返回 null", (await loadEntryImage(file, "entry-with-images", 2)) === null);
check("不存在的条目返回 null", (await loadEntryImage(file, "missing-entry", 0)) === null);
check("非 message 条目返回 null", (await loadEntryImage(file, "text-only", 0)) === null);
check("负序号 / 非整数返回 null", (await loadEntryImage(file, "entry-with-images", -1)) === null && (await loadEntryImage(file, "entry-with-images", 1.5)) === null);

fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
