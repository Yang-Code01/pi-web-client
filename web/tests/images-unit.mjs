/**
 * 图片管线（`web/src/images.ts`）里不需要浏览器的那几段：从剪贴板抖文件、分图片/其它、
 * 以及「解不出位图就把原字节原样发出去」的兜底（#402 把它从 app.ts 抽出来时顺手改了分块 base64）。
 *
 * 需要 canvas / createImageBitmap 的那半截（`rasterizeSvg` / `readImageFile` 的压缩）只能靠
 * `bridge/tests/scratch-ui.mjs` 在真 Chromium 里验。
 *
 * Run: node --experimental-strip-types web/tests/images-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ATTACH_IMAGE, downscale, pastedFilesFrom, splitImages } from "../src/images.ts";

const file = (name, type) => ({ name, type, size: 1 });

/** DataTransfer 的最小替身：`pastedFilesFrom` 只碰 items / files。 */
const transfer = (items, files = []) => ({
  items: items.map((f) => ({ kind: f.kind ?? "file", getAsFile: () => f.file })),
  files,
});

test("splitImages：图片按原顺序归 images，其余归 others", () => {
  const files = [file("a.png", "image/png"), file("b.pdf", "application/pdf"), file("c.jpg", "image/jpeg")];
  const { images, others } = splitImages(files);
  assert.deepEqual(images.map((f) => f.name), ["a.png", "c.jpg"]);
  assert.deepEqual(others.map((f) => f.name), ["b.pdf"]);
});

test("splitImages：type 为空（有些拖拽来源不给）算其它", () => {
  assert.deepEqual(splitImages([file("x", "")]).others.map((f) => f.name), ["x"]);
});

test("pastedFilesFrom：items 里的非 file 项（纯文字）被跳过", () => {
  const dt = transfer([{ kind: "string" }, { kind: "file", file: file("shot.png", "image/png") }]);
  assert.deepEqual(pastedFilesFrom(dt).map((f) => f.name), ["shot.png"]);
});

test("pastedFilesFrom：items 拿不到文件时退回 files（Safari 只给一边）", () => {
  const dt = transfer([], [file("fallback.png", "image/png")]);
  assert.deepEqual(pastedFilesFrom(dt).map((f) => f.name), ["fallback.png"]);
});

test("pastedFilesFrom：没有剪贴板数据就是空数组，不抛", () => {
  assert.deepEqual(pastedFilesFrom(null), []);
  assert.deepEqual(pastedFilesFrom({ items: [], files: [] }), []);
});

test("ATTACH_IMAGE：认常见位图与 SVG（大小写都行），不认文档", () => {
  for (const name of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.bmp", "g.avif", "h.SVG"]) {
    assert.ok(ATTACH_IMAGE.test(name), name);
  }
  for (const name of ["a.pdf", "b.md", "c.txt", "d.svgz", "e.png.zip"]) {
    assert.ok(!ATTACH_IMAGE.test(name), name);
  }
});

test("downscale：解不出位图时原字节 + 原 mime 一起发出去", async () => {
  const bytes = Uint8Array.from({ length: 16 }, (_, i) => (i * 37) % 256);
  const image = await downscale({ type: "image/png", arrayBuffer: async () => bytes.buffer }, null);
  assert.equal(image.mimeType, "image/png");
  assert.deepEqual([...Buffer.from(image.data, "base64")], [...bytes]);
});

test("downscale：没有 mime 时兜底 image/png", async () => {
  const image = await downscale({ type: "", arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }, null);
  assert.equal(image.mimeType, "image/png");
  assert.deepEqual([...Buffer.from(image.data, "base64")], [1, 2, 3]);
});

test("downscale：大文件的原字节兜底不会被展开成参数撑爆（分块拼 base64）", async () => {
  const bytes = new Uint8Array(200_000).fill(65);
  const image = await downscale({ type: "image/heic", arrayBuffer: async () => bytes.buffer }, null);
  const decoded = Buffer.from(image.data, "base64");
  assert.equal(decoded.length, bytes.length);
  assert.equal(decoded[0], 65);
  assert.equal(decoded.at(-1), 65);
});
