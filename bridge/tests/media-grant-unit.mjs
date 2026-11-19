/**
 * Unit (#542): 视频 / 音频打开时也拿到 `/api/open` 的授权（播放失败的降级卡片要能「用默认程序打开」），
 * 能播的和放不了的（avi / wmv / flv）都一样；不支持的二进制照旧。不真拉起程序，只验授权判定。
 *
 *   node --experimental-strip-types bridge/tests/media-grant-unit.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-media-grant-"));
process.env.PI_WEB_STATE = path.join(ROOT, "state");

const { openPreview } = await import("../src/preview.ts");
const { fileGrant } = await import("../src/sheet/index.ts");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const work = path.join(ROOT, "cwd");
fs.mkdirSync(work, { recursive: true });
const session = { cwd: work, file: null };
const bytes = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0, 1, 2, 0xff]);

for (const [name, kind] of [
  ["a.mp4", "video"],
  ["b.webm", "video"],
  ["c.avi", "video"],
  ["d.mkv", "video"],
  ["e.mp3", "audio"],
  ["f.flac", "audio"],
]) {
  const p = path.join(work, name);
  fs.writeFileSync(p, bytes);
  const info = openPreview(session, p);
  check(`${name} 是 ${kind}`, info.kind === kind, info.kind);
  check(`${name} 有 /api/open 的授权`, !!fileGrant(info.token));
}

fs.rmSync(ROOT, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
