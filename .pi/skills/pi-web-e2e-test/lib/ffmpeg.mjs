import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

let cached = null;

function safeSpawnSync(cmd, args) {
  try {
    return spawnSync(cmd, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000
    });
  } catch (error) {
    return { status: -1, stdout: "", stderr: String(error) };
  }
}

function encoderNames(ffmpeg) {
  const result = safeSpawnSync(ffmpeg, ["-hide_banner", "-encoders"]);
  if (result.status !== 0) return new Set();
  const names = new Set();
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const match = line.match(/^\s*[VAS][A-Z.]*\s+(\S+)/);
    if (match) names.add(match[1]);
  }
  return names;
}

/**
 * Locate a full ffmpeg build. Playwright ships a video-only ffmpeg (no AAC,
 * no H.264); refuse it instead of producing silent/broken clips.
 */
export function findFfmpeg(explicit) {
  if (cached) return cached;
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  candidates.push("ffmpeg");
  const rejected = [];
  for (const ffmpeg of candidates) {
    const version = safeSpawnSync(ffmpeg, ["-version"]);
    if (version.status !== 0) {
      rejected.push(`${ffmpeg}: not runnable`);
      continue;
    }
    const encoders = encoderNames(ffmpeg);
    if (!encoders.has("libx264") || !encoders.has("aac")) {
      rejected.push(`${ffmpeg}: missing libx264/aac`);
      continue;
    }
    const dir = path.dirname(ffmpeg);
    const probeCandidates = [];
    if (process.env.FFPROBE_PATH) probeCandidates.push(process.env.FFPROBE_PATH);
    if (dir && dir !== ".") {
      probeCandidates.push(path.join(dir, process.platform === "win32" ? "ffprobe.exe" : "ffprobe"));
    }
    probeCandidates.push("ffprobe");
    let ffprobe = "";
    for (const probe of probeCandidates) {
      const result = safeSpawnSync(probe, ["-version"]);
      if (result.status === 0) {
        ffprobe = probe;
        break;
      }
    }
    if (!ffprobe) {
      rejected.push(`${ffmpeg}: ffprobe not found`);
      continue;
    }
    cached = {
      ffmpeg,
      ffprobe,
      version: String(version.stdout || "").split(/\r?\n/)[0] || "",
      encoders
    };
    return cached;
  }
  throw new Error(
    `找不到可用的 ffmpeg（需要 libx264 + aac）与 ffprobe。尝试过：\n${rejected.join("\n")}\n` +
      "请设置 FFMPEG_PATH / FFPROBE_PATH，或安装完整版 ffmpeg。"
  );
}

function run(ffmpeg, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpeg, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      reject(new Error(`${ffmpeg} 启动失败：${error.message}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, options.timeout == null ? 120000 : options.timeout);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${ffmpeg} 执行失败：${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${ffmpeg} 超时：${args.join(" ")}`));
        return;
      }
      if (code !== 0) {
        const tail = stderr.trim().split(/\r?\n/).slice(-12).join("\n");
        reject(new Error(`${ffmpeg} 退出码 ${code}\n${args.join(" ")}\n${tail}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function probeDuration(file) {
  const { ffprobe } = findFfmpeg();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      ffprobe,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
      { windowsHide: true }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`ffprobe 失败：${err.trim()}`));
      else resolve(out.trim());
    });
  });
  const duration = Number.parseFloat(result);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`读不到视频时长：${file}`);
  }
  return duration;
}

export async function probeVideo(file) {
  const { ffprobe } = findFfmpeg();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      ffprobe,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,width,height,r_frame_rate,duration:format=duration",
        "-of",
        "json",
        file
      ],
      { windowsHide: true }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`ffprobe 失败：${err.trim()}`));
      else resolve(out);
    });
  });
  let parsed;
  try {
    parsed = JSON.parse(result);
  } catch {
    throw new Error(`ffprobe 输出不是 JSON：${file}`);
  }
  const stream = (parsed.streams || [])[0] || {};
  const duration = Number.parseFloat(stream.duration || (parsed.format || {}).duration || "0");
  const [num, den] = String(stream.r_frame_rate || "0/1").split("/").map(Number);
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    video: {
      codec: stream.codec_name || "",
      width: stream.width || 0,
      height: stream.height || 0,
      fps: den ? num / den : 0
    }
  };
}

function fmt(value) {
  return Number(value).toFixed(3);
}

/** Build the trim/setpts/concat filter for a final video. Pure for tests. */
export function buildVideoFilter(slowSegments, duration, fps = 25) {
  const total = Math.max(0, Number(duration) || 0);
  const clamp = (value) => Math.max(0, Math.min(total, Number(value) || 0));
  const merged = [];
  for (const segment of slowSegments || []) {
    const start = clamp(segment.start);
    const end = clamp(segment.end);
    if (end <= start + 0.01) continue;
    const slow = Math.max(0.05, Number(segment.slow) || 0.25);
    const last = merged[merged.length - 1];
    if (last && start <= last.end + 0.01) {
      last.end = Math.max(last.end, end);
      last.slow = Math.min(last.slow, slow);
    } else {
      merged.push({ start, end, slow });
    }
  }
  const pieces = [];
  let cursor = 0;
  for (const segment of merged) {
    if (segment.start > cursor + 0.01) {
      pieces.push({ start: cursor, end: segment.start, slow: 1 });
    }
    pieces.push({ start: segment.start, end: segment.end, slow: segment.slow });
    cursor = Math.max(cursor, segment.end);
  }
  if (cursor < total - 0.01) {
    pieces.push({ start: cursor, end: total, slow: 1 });
  }
  if (pieces.length === 0) {
    pieces.push({ start: 0, end: total, slow: 1 });
  }
  const chains = pieces.map((piece, index) => {
    const pts = piece.slow === 1 ? "PTS-STARTPTS" : `(PTS-STARTPTS)/${piece.slow}`;
    return `[0:v]trim=start=${fmt(piece.start)}:end=${fmt(piece.end)},setpts=${pts},fps=${fps}[v${index}]`;
  });
  const join =
    pieces.length === 1
      ? "[v0]null[out]"
      : `${pieces.map((_, index) => `[v${index}]`).join("")}concat=n=${pieces.length}:v=1:a=0[out]`;
  return { pieces, filter: `${chains.join(";")};${join}` };
}

export async function transcodeWithSlowmo({ input, output, slowSegments, fps = 25 }) {
  const { ffmpeg } = findFfmpeg();
  const duration = await probeDuration(input);
  const { filter } = buildVideoFilter(slowSegments, duration, fps);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await run(
    ffmpeg,
    [
      "-y",
      "-i",
      input,
      "-filter_complex",
      filter,
      "-map",
      "[out]",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      output
    ],
    { timeout: 300000 }
  );
  return { input, output, rawDuration: duration, filter };
}

export async function muxAudio({ video, audio, output }) {
  const { ffmpeg } = findFfmpeg();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await run(
    ffmpeg,
    [
      "-y",
      "-i",
      video,
      "-i",
      audio,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-shortest",
      "-movflags",
      "+faststart",
      output
    ],
    { timeout: 120000 }
  );
  return output;
}

export async function sliceClip({ input, start, end, output }) {
  const { ffmpeg } = findFfmpeg();
  const from = Math.max(0, Number(start) || 0);
  const to = Math.max(from + 0.1, Number(end) || 0);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await run(
    ffmpeg,
    [
      "-y",
      "-ss",
      fmt(from),
      "-i",
      input,
      "-t",
      fmt(to - from),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      output
    ],
    { timeout: 120000 }
  );
  return { output, start: from, end: to, duration: to - from };
}

export async function poster({ input, output, at = 1 }) {
  const { ffmpeg } = findFfmpeg();
  const duration = await probeDuration(input);
  const time = Math.max(0, Math.min(Number(at) || 0, duration - 0.05));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await run(
    ffmpeg,
    ["-y", "-ss", fmt(time), "-i", input, "-frames:v", "1", "-q:v", "2", output],
    { timeout: 60000 }
  );
  return output;
}

export function ffmpegInfo() {
  const info = findFfmpeg();
  return {
    ffmpeg: info.ffmpeg,
    ffprobe: info.ffprobe,
    version: info.version,
    libx264: info.encoders.has("libx264"),
    aac: info.encoders.has("aac")
  };
}
