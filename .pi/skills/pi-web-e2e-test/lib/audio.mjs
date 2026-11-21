/**
 * Small WAV toolkit: parse SAPI output, resample to the mixing rate, place each
 * step's narration at its final timestamp, and write one PCM track. Keeping this
 * in Node means the audio timeline is testable without running ffmpeg.
 */

const HEADER_BYTES = 44;

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("expected a Buffer or Uint8Array");
}

function ascii(buf, offset, length) {
  return buf.toString("ascii", offset, offset + length);
}

/** Parse the RIFF chunks we care about. Throws on non-PCM/non-WAV input. */
export function parseWav(value) {
  const buf = asBuffer(value);
  if (buf.length < 12 || ascii(buf, 0, 4) !== "RIFF" || ascii(buf, 8, 4) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let audioFormat = null;
  let channels = null;
  let sampleRate = null;
  let bitsPerSample = null;
  let dataOffset = null;
  let dataLength = null;

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = ascii(buf, offset, 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      audioFormat = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataLength = Math.min(size, Math.max(0, buf.length - body));
      dataOffset = body;
    }
    const next = body + size + (size & 1);
    if (next <= offset) break;
    offset = next;
  }

  if (audioFormat == null || channels == null || sampleRate == null || bitsPerSample == null || dataOffset == null) {
    throw new Error("WAV is missing fmt/data chunks");
  }
  if (audioFormat !== 1) throw new Error(`unsupported WAV format ${audioFormat} (only PCM)`);

  const blockAlign = channels * (bitsPerSample / 8);
  const duration = blockAlign > 0 ? dataLength / (sampleRate * blockAlign) : 0;
  return { audioFormat, channels, sampleRate, bitsPerSample, dataOffset, dataLength, duration };
}

/** Convert PCM16 WAV to mono float samples, optionally resampling. */
export function wavToMonoFloat(value, targetRate = 44100) {
  const buf = asBuffer(value);
  const wav = parseWav(buf);
  if (wav.bitsPerSample !== 16) throw new Error(`unsupported WAV bits ${wav.bitsPerSample} (only 16)`);
  const frameBytes = wav.channels * 2;
  const frames = Math.floor(wav.dataLength / frameBytes);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let ch = 0; ch < wav.channels; ch++) sum += buf.readInt16LE(wav.dataOffset + i * frameBytes + ch * 2);
    mono[i] = sum / wav.channels / 32768;
  }
  if (!Number.isFinite(targetRate) || targetRate <= 0 || targetRate === wav.sampleRate) return mono;
  const outLength = Math.round((frames * targetRate) / wav.sampleRate);
  const out = new Float32Array(outLength);
  const ratio = wav.sampleRate / targetRate;
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = mono[i0] ?? 0;
    const b = mono[Math.min(i0 + 1, frames - 1)] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * Place clips on a silent track. Each clip is `{start, buffer}` or
 * `{start, samples}`; `start` is final-video seconds.
 */
export function mixClips(clips, totalDuration, sampleRate = 44100) {
  const frames = Math.max(0, Math.ceil(totalDuration * sampleRate));
  const out = new Float32Array(frames);
  for (const clip of clips ?? []) {
    const samples = clip.samples ?? wavToMonoFloat(clip.buffer, sampleRate);
    const start = Math.max(0, Number(clip.start) || 0);
    const offset = Math.round(start * sampleRate);
    if (offset >= frames) continue;
    const count = Math.min(samples.length, frames - offset);
    for (let i = 0; i < count; i++) out[offset + i] += samples[i];
  }
  return out;
}

/** Encode mono float samples as a 16-bit PCM WAV. */
export function encodeWavMono(samples, sampleRate = 44100) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i] ?? 0));
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), i * 2);
  }
  const header = Buffer.alloc(HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function silenceWav(duration, sampleRate = 44100) {
  const frames = Math.max(0, Math.floor(duration * sampleRate));
  return encodeWavMono(new Float32Array(frames), sampleRate);
}

export function mixToWav(clips, totalDuration, sampleRate = 44100) {
  return encodeWavMono(mixClips(clips, totalDuration, sampleRate), sampleRate);
}

export function wavDuration(value) {
  return parseWav(value).duration;
}
