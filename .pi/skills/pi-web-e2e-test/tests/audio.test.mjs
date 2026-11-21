import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeWavMono,
  mixClips,
  mixToWav,
  parseWav,
  silenceWav,
  wavDuration,
  wavToMonoFloat,
} from "../lib/audio.mjs";

function pcmWav({ seconds = 1, rate = 8000, channels = 1, value = 0.5, freq = 0 }) {
  const frames = Math.floor(seconds * rate);
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const sample = freq ? Math.sin((2 * Math.PI * freq * i) / rate) * value : value;
    const int = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    for (let ch = 0; ch < channels; ch++) data.writeInt16LE(int, (i * channels + ch) * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test("parses a PCM WAV header and duration", () => {
  const wav = parseWav(pcmWav({ seconds: 0.5, rate: 8000 }));
  assert.equal(wav.sampleRate, 8000);
  assert.equal(wav.channels, 1);
  assert.equal(wav.bitsPerSample, 16);
  assert.equal(wav.dataLength, 8000);
  assert.equal(wav.duration, 0.5);
});

test("resamples to the mixing rate and preserves amplitude", () => {
  const samples = wavToMonoFloat(pcmWav({ seconds: 0.1, rate: 8000, value: 0.5 }), 44100);
  assert.equal(samples.length, 4410);
  assert.ok(Math.abs(samples[0] - 0.5) < 0.001);
  assert.ok(Math.abs(samples[4409] - 0.5) < 0.001);
});

test("encodes mono 16-bit WAV with a readable header", () => {
  const samples = new Float32Array(44100);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.25;
  const wav = encodeWavMono(samples, 44100);
  const parsed = parseWav(wav);
  assert.equal(parsed.sampleRate, 44100);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.bitsPerSample, 16);
  assert.ok(Math.abs(parsed.duration - 1) < 0.001);
  assert.equal(wav.length, 44 + samples.length * 2);
});

test("mixes clips at their mapped offsets and pads silence", () => {
  const a = pcmWav({ seconds: 0.1, rate: 44100, value: 0.5 });
  const b = pcmWav({ seconds: 0.1, rate: 44100, value: 0.25 });
  const mixed = mixClips(
    [
      { start: 0, buffer: a },
      { start: 0.2, buffer: b },
    ],
    0.5,
    44100,
  );
  assert.equal(mixed.length, 22050);
  assert.ok(Math.abs(mixed[100] - 0.5) < 0.001);
  assert.ok(Math.abs(mixed[6000]) < 0.001);
  assert.ok(Math.abs(mixed[9000] - 0.25) < 0.001);
});

test("overlapping clips add and the encoder clamps", () => {
  const loud = pcmWav({ seconds: 0.1, rate: 44100, value: 0.8 });
  const mixed = mixClips(
    [
      { start: 0, buffer: loud },
      { start: 0.05, buffer: loud },
    ],
    0.2,
    44100,
  );
  assert.ok(mixed[3000] > 1);
  const wav = encodeWavMono(mixed, 44100);
  const parsed = parseWav(wav);
  assert.equal(parsed.duration, 0.2);
  assert.equal(wav.readInt16LE(44 + 3000 * 2), 32767);
});

test("silence WAV has the requested duration", () => {
  const wav = silenceWav(1.25, 22050);
  assert.ok(Math.abs(wavDuration(wav) - 1.25) < 0.001);
  assert.equal(parseWav(wav).dataLength, 27562 * 2);
});

test("mixToWav produces a complete WAV", () => {
  const wav = mixToWav([{ start: 0.1, buffer: pcmWav({ seconds: 0.1, value: 0.4 }) }], 0.5, 44100);
  assert.ok(Math.abs(wavDuration(wav) - 0.5) < 0.001);
  assert.equal(parseWav(wav).sampleRate, 44100);
});
