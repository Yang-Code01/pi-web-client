import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildVideoFilter,
  findFfmpeg,
  ffmpegInfo,
  poster,
  probeDuration,
  probeVideo,
  sliceClip,
  transcodeWithSlowmo
} from "../lib/ffmpeg.mjs";

test("buildVideoFilter covers the whole timeline and slow segments stretch", () => {
  const result = buildVideoFilter([{ start: 1, end: 2, slow: 0.5 }], 4, 25);
  assert.deepEqual(result.pieces, [
    { start: 0, end: 1, slow: 1 },
    { start: 1, end: 2, slow: 0.5 },
    { start: 2, end: 4, slow: 1 }
  ]);
  assert.match(result.filter, /trim=start=1\.000:end=2\.000,setpts=\(PTS-STARTPTS\)\/0\.5/);
  assert.match(result.filter, /concat=n=3:v=1:a=0\[out\]/);
});

test("buildVideoFilter clamps and skips empty segments", () => {
  const result = buildVideoFilter(
    [
      { start: -1, end: 0.5, slow: 0.25 },
      { start: 0.4, end: 0.45, slow: 0.25 },
      { start: 3, end: 9, slow: 0.25 }
    ],
    3,
    30
  );
  assert.deepEqual(result.pieces, [
    { start: 0, end: 0.5, slow: 0.25 },
    { start: 0.5, end: 3, slow: 1 }
  ]);
  assert.match(result.filter, /concat=n=2:v=1:a=0\[out\]/);
});

test("system ffmpeg has the encoders the pipeline needs", (t) => {
  try {
    const info = ffmpegInfo();
    assert.ok(info.libx264);
    assert.ok(info.aac);
    assert.match(info.version, /ffmpeg version/);
  } catch (error) {
    t.skip(error.message);
  }
});

test("transcode + mux + slice produces a playable MP4", async (t) => {
  let info;
  try {
    info = findFfmpeg();
  } catch (error) {
    t.skip(error.message);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ffmpeg-"));
  try {
    const raw = path.join(dir, "raw.mp4");
    execFileSync(
      info.ffmpeg,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x240:d=4",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        raw
      ],
      { windowsHide: true }
    );
    const slow = path.join(dir, "slow.mp4");
    await transcodeWithSlowmo({
      input: raw,
      output: slow,
      slowSegments: [{ start: 1, end: 2, slow: 0.5 }],
      fps: 25
    });
    const duration = await probeDuration(slow);
    assert.ok(Math.abs(duration - 5) < 0.25, `expected ~5s, got ${duration}`);
    const probed = await probeVideo(slow);
    assert.equal(probed.video.codec, "h264");
    assert.equal(probed.video.width, 320);

    const image = path.join(dir, "poster.jpg");
    await poster({ input: slow, output: image, at: 0.5 });
    assert.ok(fs.statSync(image).size > 100);

    const clip = path.join(dir, "clip.mp4");
    await sliceClip({ input: slow, start: 0.2, end: 1.8, output: clip });
    const clipDuration = await probeDuration(clip);
    assert.ok(Math.abs(clipDuration - 1.6) < 0.2, `expected ~1.6s, got ${clipDuration}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
