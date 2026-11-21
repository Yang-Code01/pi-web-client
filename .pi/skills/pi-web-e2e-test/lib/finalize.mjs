/**
 * Turn raw recordings (one per side) into the final MP4s, VTTs, posters and
 * the `spec.json` the report reads. This module is deliberately free of
 * Playwright: it only needs the raw specs and the system ffmpeg.
 */

import fs from "node:fs";
import path from "node:path";
import { mergeSlowSegments, buildTimeMap } from "./timeline.mjs";
import { buildVtt, sliceCues } from "./vtt.mjs";
import { mixToWav, silenceWav } from "./audio.mjs";
import { safeFileStem } from "./slug.mjs";
import {
  probeDuration,
  transcodeWithSlowmo,
  muxAudio,
  sliceClip,
  poster
} from "./ffmpeg.mjs";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function rel(root, file) {
  return path.relative(root, file).replace(/\\/g, "/");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sideSpecPath(outDir, side) {
  return path.join(outDir, `raw-spec-${side}.json`);
}

function cueText(step) {
  const title = String(step.title || step.caption || "").trim();
  const say = String(step.say || "").trim();
  if (title && say && say !== title) return `${title} — ${say}`;
  return title || say;
}

/**
 * One caption cue per step, ending at the next step. The last cue gets a
 * little tail so it does not disappear the instant the outro card appears.
 */
export function buildStepCues(steps, timeMap, finalDuration) {
  const list = Array.isArray(steps) ? steps : [];
  const cues = [];
  for (let index = 0; index < list.length; index += 1) {
    const step = list[index];
    const start = timeMap.map(step.t);
    if (start >= finalDuration) continue;
    const nextStart =
      index + 1 < list.length ? timeMap.map(list[index + 1].t) : finalDuration;
    const naturalEnd = start + Math.max(2.0, (Number(step.audioDuration) || 0) + 0.7);
    const nextEnd = nextStart > start + 0.05 ? nextStart - 0.05 : naturalEnd;
    const end = clamp(nextEnd, start + 0.35, finalDuration);
    const text = cueText(step);
    if (text && end > start + 0.05) cues.push({ start, end, text });
  }
  return cues;
}

async function finalizeSide({ outDir, side, fps, log }) {
  const rawFile = sideSpecPath(outDir, side);
  if (!fs.existsSync(rawFile)) {
    throw new Error(`缺少 ${side} 的原始录制：${rawFile}`);
  }
  const raw = readJson(rawFile);
  if (!raw.videoSaved || !raw.rawVideo || !fs.existsSync(raw.rawVideo)) {
    throw new Error(`${side} 没有可用的录制文件（${raw.error || raw.rawVideo || "未知"}）`);
  }

  const rawDuration =
    Number(raw.durationRaw) > 0.1 ? Number(raw.durationRaw) : await probeDuration(raw.rawVideo);
  const segments = mergeSlowSegments(raw.moments || [], rawDuration, {
    lead: 0.8,
    tail: 0.6,
    slow: 0.25
  });
  const timeMap = buildTimeMap(segments);
  const finalDuration = Math.max(0.2, timeMap.finalDuration(rawDuration));

  const mediaDir = path.join(outDir, "media");
  const rawDir = path.join(outDir, "raw");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(rawDir, { recursive: true });

  const videoTemp = path.join(rawDir, `${side}-video.mp4`);
  log(`${side}: 转码 + 慢放（${segments.length} 段）→ ${finalDuration.toFixed(2)}s`);
  await transcodeWithSlowmo({
    input: raw.rawVideo,
    output: videoTemp,
    slowSegments: segments,
    fps
  });

  const clips = [];
  for (const step of raw.steps || []) {
    if (!step.audio) continue;
    if (!fs.existsSync(step.audio)) continue;
    const start = timeMap.map(step.t);
    if (start >= finalDuration) continue;
    clips.push({ start, buffer: fs.readFileSync(step.audio) });
  }
  const wavPath = path.join(rawDir, `${side}-mix.wav`);
  fs.writeFileSync(
    wavPath,
    clips.length ? mixToWav(clips, finalDuration) : silenceWav(finalDuration)
  );

  const videoFile = path.join(mediaDir, `${side}.mp4`);
  await muxAudio({ video: videoTemp, audio: wavPath, output: videoFile });

  const cues = buildStepCues(raw.steps || [], timeMap, finalDuration);
  const vttFile = path.join(mediaDir, `${side}.vtt`);
  fs.writeFileSync(vttFile, buildVtt(cues, finalDuration));

  const posterFile = path.join(mediaDir, `${side}.jpg`);
  await poster({
    input: videoFile,
    output: posterFile,
    at: Math.min(1.6, finalDuration / 2)
  });

  const usedStems = new Set();
  const caseResults = [];
  for (let index = 0; index < (raw.cases || []).length; index += 1) {
    const item = raw.cases[index];
    const start = clamp(timeMap.map(item.tStart), 0, Math.max(0, finalDuration - 0.15));
    const end = clamp(
      timeMap.map(item.tEnd || rawDuration),
      start + 0.15,
      finalDuration
    );
    let stem = safeFileStem(item.id || `case-${index + 1}`) || `case-${index + 1}`;
    let suffix = 2;
    const baseStem = stem;
    while (usedStems.has(stem)) {
      stem = `${baseStem}-${suffix}`;
      suffix += 1;
    }
    usedStems.add(stem);

    const clipFile = path.join(mediaDir, `${side}-${stem}.mp4`);
    const clipVtt = path.join(mediaDir, `${side}-${stem}.vtt`);
    await sliceClip({ input: videoFile, start, end, output: clipFile });
    fs.writeFileSync(clipVtt, buildVtt(sliceCues(cues, start, end), end - start));

    caseResults.push({
      ...item,
      tFinalStart: start,
      tFinalEnd: end,
      video: rel(outDir, clipFile),
      vtt: rel(outDir, clipVtt),
      steps: (item.steps || []).map((step) => ({
        ...step,
        tFinal: timeMap.map(step.t)
      }))
    });
  }

  return {
    ...raw,
    side,
    duration: finalDuration,
    bytes: fs.statSync(videoFile).size,
    durationRaw: rawDuration,
    segments,
    video: rel(outDir, videoFile),
    vtt: rel(outDir, vttFile),
    poster: rel(outDir, posterFile),
    steps: (raw.steps || []).map((step) => ({
      ...step,
      tFinal: timeMap.map(step.t)
    })),
    cases: caseResults,
    status: caseStatus(raw)
  };
}

export function caseStatus(raw) {
  if (raw?.error) return "error";
  if ((raw?.cases || []).some((item) => item.status === "error")) return "error";
  if ((raw?.cases || []).some((item) => item.status === "fail")) return "fail";
  if ((raw?.asserts || []).some((assertion) => !assertion.pass)) return "fail";
  return "pass";
}

export function verdict(before, after) {
  if (!before && !after) return "missing";
  if (!before) return "missing-before";
  if (!after) return "missing-after";
  if (before.status === "pass" && after.status === "pass") return "pass";
  if (before.status !== "pass" && after.status === "pass") return "fixed";
  if (before.status === "pass" && after.status !== "pass") return "regressed";
  return "both-fail";
}

export function mergeCases(sides) {
  const map = new Map();
  for (const side of sides) {
    for (const item of side.cases || []) {
      const id = String(item.id || "run");
      let entry = map.get(id);
      if (!entry) {
        entry = {
          id,
          title: item.title || id,
          expect: item.expect || "",
          before: null,
          after: null
        };
        map.set(id, entry);
      }
      if (!entry.title && item.title) entry.title = item.title;
      if (!entry.expect && item.expect) entry.expect = item.expect;
      entry[side.side] = {
        status: item.status,
        video: item.video,
        vtt: item.vtt,
        tFinalStart: item.tFinalStart,
        tFinalEnd: item.tFinalEnd,
        steps: item.steps || [],
        asserts: item.asserts || [],
        errors: item.errors || [],
        duration: Math.max(0, item.tFinalEnd - item.tFinalStart)
      };
    }
  }
  const cases = [...map.values()].map((entry) => ({
    ...entry,
    verdict: verdict(entry.before, entry.after)
  }));
  cases.sort((a, b) => {
    const aTime = a.before?.tFinalStart ?? a.after?.tFinalStart ?? 0;
    const bTime = b.before?.tFinalStart ?? b.after?.tFinalStart ?? 0;
    return aTime - bTime;
  });
  return cases;
}

function countCases(cases, key) {
  const result = { total: cases.length, pass: 0, fail: 0, error: 0, missing: 0 };
  for (const item of cases) {
    const side = item[key];
    if (!side) {
      result.missing += 1;
      continue;
    }
    result[side.status] = (result[side.status] || 0) + 1;
  }
  return result;
}

/**
 * Finalize every side that has a raw spec, write `spec.json`, and return it.
 */
export async function finalizeRun(options) {
  const outDir = path.resolve(options.outDir);
  const fps = Number(options.fps) || 25;
  const log = options.log || (() => {});
  const sideNames = (options.sides || ["after"]).filter((side) =>
    fs.existsSync(sideSpecPath(outDir, side))
  );
  if (sideNames.length === 0) {
    throw new Error(`没有找到任何原始录制（raw-spec-<side>.json，目录 ${outDir}）`);
  }

  const finalized = [];
  for (const side of sideNames) {
    finalized.push(await finalizeSide({ outDir, side, fps, log }));
  }

  const cases = mergeCases(finalized);
  const after = finalized.find((item) => item.side === "after") || finalized[0];
  const before = finalized.find((item) => item.side === "before") || null;
  const meta = { ...(after.meta || before?.meta || {}), ...(options.meta || {}) };

  const spec = {
    schema: 1,
    title: meta.title || after.reportTitle || after.title || "pi-web-e2e-test",
    generatedAt: new Date().toISOString(),
    outDir,
    fps,
    meta,
    command: options.command || "",
    caseFile: options.caseFile ? rel(outDir, path.resolve(options.caseFile)) : after.caseFile || "",
    git: {
      before: before?.git || null,
      after: after.git || null
    },
    env: {
      before: before?.env || null,
      after: after.env || null
    },
    sides: Object.fromEntries(
      finalized.map((side) => [
        side.side,
        {
          side: side.side,
          title: side.title,
          reportTitle: side.reportTitle,
          baseUrl: side.baseUrl,
          duration: side.duration,
          durationRaw: side.durationRaw,
          video: side.video,
          vtt: side.vtt,
          bytes: side.bytes || 0,
          poster: side.poster,
          status: side.status,
          asserts: side.asserts || [],
          errors: side.errors || [],
          console: side.console || [],
          network: side.network || [],
          steps: side.steps || [],
          segments: side.segments || [],
          moments: side.moments || [],
          tts: side.tts || null,
          login: side.login || null,
          git: side.git || null,
          env: side.env || null
        }
      ])
    ),
    cases,
    summary: {
      before: countCases(cases, "before"),
      after: countCases(cases, "after")
    }
  };

  writeJson(path.join(outDir, "spec.json"), spec);
  log(`spec.json: ${cases.length} 条用例，before=${spec.summary.before.total}，after=${spec.summary.after.total}`);
  return spec;
}

export { sideSpecPath };
