/**
 * The recorder sees raw wall-clock seconds. Slow-motion moments are inserted after
 * recording, so every step/mark/audio cue has to be remapped from raw time to final
 * video time. All of that lives here so the mapping can be unit-tested without a
 * browser or ffmpeg.
 */

const EPS = 1e-9;

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Turn `h.moment()` entries into non-overlapping slow ranges in raw time.
 *
 * @param {Array<{t:number, lead?:number, tail?:number, slow?:number}>} moments
 * @param {number} duration raw video duration in seconds
 * @param {{lead?:number, tail?:number, slow?:number}} [defaults]
 * @returns {Array<{start:number, end:number, slow:number}>}
 */
export function mergeSlowSegments(moments, duration, defaults = {}) {
  const leadDefault = finite(defaults.lead, 0.8);
  const tailDefault = finite(defaults.tail, 0.6);
  const slowDefault = finite(defaults.slow, 0.25);
  const total = Math.max(0, finite(duration, 0));
  const ranges = [];

  for (const moment of moments ?? []) {
    const t = finite(moment?.t, Number.NaN);
    if (!Number.isFinite(t) || t < 0 || t > total) continue;
    const lead = Math.max(0, finite(moment?.lead, leadDefault));
    const tail = Math.max(0, finite(moment?.tail, tailDefault));
    const slow = Math.min(1, Math.max(1e-6, finite(moment?.slow, slowDefault)));
    const start = Math.max(0, t - lead);
    const end = Math.min(total, t + tail);
    if (end <= start + EPS) continue;
    ranges.push({ start, end, slow });
  }

  ranges.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + EPS) {
      last.end = Math.max(last.end, range.end);
      last.slow = Math.min(last.slow, range.slow);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Build `raw -> final` and `final -> raw` mappings for a set of slow ranges.
 * `slow` is a playback speed: 0.25 means the range is stretched to 4x.
 */
export function buildTimeMap(segments) {
  const segs = (segments ?? [])
    .map((s) => ({
      start: Math.max(0, finite(s.start, 0)),
      end: Math.max(0, finite(s.end, 0)),
      slow: Math.min(1, Math.max(1e-6, finite(s.slow, 1))),
    }))
    .filter((s) => s.end > s.start + EPS)
    .sort((a, b) => a.start - b.start);

  function map(rawTime) {
    const t = Math.max(0, finite(rawTime, 0));
    let cursor = 0;
    let final = 0;
    for (const s of segs) {
      if (t <= s.start) return final + Math.max(0, t - cursor);
      final += s.start - cursor;
      if (t < s.end) return final + (t - s.start) / s.slow;
      final += (s.end - s.start) / s.slow;
      cursor = s.end;
    }
    return final + Math.max(0, t - cursor);
  }

  function inverse(finalTime) {
    const t = Math.max(0, finite(finalTime, 0));
    let raw = 0;
    let final = 0;
    for (const s of segs) {
      const normal = s.start - raw;
      if (t < final + normal) return raw + (t - final);
      final += normal;
      const slowLength = (s.end - s.start) / s.slow;
      if (t < final + slowLength) return s.start + (t - final) * s.slow;
      final += slowLength;
      raw = s.end;
    }
    return raw + (t - final);
  }

  return {
    segments: segs,
    map,
    inverse,
    finalDuration(rawDuration) {
      return map(rawDuration);
    },
  };
}
