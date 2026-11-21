import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTts, listTtsVoices } from "../lib/tts.mjs";

test("tts disabled degrades without touching the filesystem", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-tts-off-"));
  try {
    const tts = createTts({ dir, enabled: false });
    const result = await tts.speak("你好");
    assert.equal(result.ok, false);
    assert.match(result.reason, /disabled/);
    assert.deepEqual(tts.failures, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SAPI voice list contains a Chinese voice on this machine", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows only");
    return;
  }
  const voices = await listTtsVoices();
  if (voices.length === 0) {
    t.skip("no SAPI voices");
    return;
  }
  assert.ok(voices.some((voice) => /^zh/i.test(voice.culture)), "expected a zh-* voice");
});

test("SAPI generates a cached WAV with a readable duration", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows only");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-tts-"));
  try {
    const tts = createTts({ dir, rate: -1 });
    const first = await tts.speak("现在打开新会话面板。");
    if (!first.ok) {
      t.skip(first.reason || first.error || "SAPI unavailable");
      return;
    }
    assert.ok(first.duration > 0.5);
    assert.ok(fs.existsSync(first.path));
    const second = await tts.speak("现在打开新会话面板。");
    assert.equal(second.ok, true);
    assert.equal(second.cached, true);
    assert.equal(second.path, first.path);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
