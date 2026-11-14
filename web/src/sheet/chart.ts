/**
 * #434 图表的画法：把桥端读出来的值画成 SVG。
 *
 * 为什么是 SVG 不是 canvas：格子会随缩放重排，SVG 设一个 viewBox 就能跟着
 * 宽高缩放，不用在每次滚动/缩放时重画；文字也不会糊。
 *
 * 配色用 Office 2013 之后的那套主题色（Excel 默认图表就是这几支），
 * 不读文件里的 `c:spPr`——那是每个点/每条线的填充描边，读全了写不划算。
 */
import type { SheetChart } from "../types.ts";

const PALETTE = ["#4472C4", "#ED7D31", "#A5A5A5", "#FFC000", "#5B9BD5", "#70AD47", "#264478", "#9E480E"];

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 值域：0 到最大值（负数也管），留 5% 余量。 */
function bounds(values: (number | null)[]): { min: number; max: number } {
  const nums = values.filter((v): v is number => typeof v === "number");
  if (!nums.length) return { min: 0, max: 1 };
  const min = Math.min(0, ...nums);
  const max = Math.max(0, ...nums);
  return { min, max: max === min ? min + 1 : max };
}

function fmt(v: number): string {
  if (Math.abs(v) >= 10000) return `${Math.round(v / 1000)}k`;
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(1);
}

function xy(chart: SheetChart, w: number, h: number): string {
  const padL = 38;
  const padR = 10;
  const padT = chart.title ? 26 : 12;
  const padB = chart.cats.length ? 20 : 10;
  const pw = Math.max(10, w - padL - padR);
  const ph = Math.max(10, h - padT - padB);
  const all = chart.series.flatMap((s) => s.values);
  const { min, max } = bounds(all);
  const y = (v: number): number => padT + ph - ((v - min) / (max - min)) * ph;
  const n = Math.max(1, Math.max(...chart.series.map((s) => s.values.length), chart.cats.length));
  const part: string[] = [];

  // 三条水平参考线（0 线、1/2、顶）
  for (let i = 0; i <= 2; i++) {
    const v = min + ((max - min) * i) / 2;
    const yy = y(v).toFixed(1);
    part.push(`<line x1="${padL}" x2="${w - padR}" y1="${yy}" y2="${yy}" stroke="#e6e6e6" stroke-width="1"/>`);
    part.push(`<text x="${padL - 6}" y="${Number(yy) + 3}" text-anchor="end" font-size="9" fill="#767676">${fmt(v)}</text>`);
  }

  const horizontal = !!chart.horizontal;
  if (chart.kind === "bar") {
    const band = (horizontal ? ph : pw) / n;
    const each = (band * 0.72) / Math.max(1, chart.series.length);
    chart.series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        if (typeof v !== "number") return;
        if (horizontal) {
          const yy = padT + i * band + band * 0.14 + si * each;
          const x0 = padL;
          const x1 = padL + ((v - min) / (max - min)) * pw;
          part.push(`<rect x="${Math.min(x0, x1).toFixed(1)}" y="${yy.toFixed(1)}" width="${Math.abs(x1 - x0).toFixed(1)}" height="${Math.max(1, each - 2).toFixed(1)}" fill="${PALETTE[si % PALETTE.length]}"/>`);
        } else {
          const xx = padL + i * band + band * 0.14 + si * each;
          const y0 = y(0);
          const y1 = y(v);
          part.push(`<rect x="${xx.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${Math.max(1, each - 2).toFixed(1)}" height="${Math.max(1, Math.abs(y0 - y1)).toFixed(1)}" fill="${PALETTE[si % PALETTE.length]}"/>`);
        }
      });
    });
  } else {
    chart.series.forEach((s, si) => {
      const pts = s.values
        .map((v, i) => (typeof v === "number" ? `${(padL + (pw * (i + 0.5)) / n).toFixed(1)},${y(v).toFixed(1)}` : null))
        .filter((p): p is string => !!p);
      if (!pts.length) return;
      const color = PALETTE[si % PALETTE.length];
      if (chart.kind === "area") {
        part.push(`<polygon points="${padL},${y(0).toFixed(1)} ${pts.join(" ")} ${(padL + pw).toFixed(1)},${y(0).toFixed(1)}" fill="${color}" fill-opacity="0.35"/>`);
      }
      part.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2"/>`);
      if (chart.kind !== "scatter") {
        for (const p of pts) {
          const [px, py] = p.split(",");
          part.push(`<circle cx="${px}" cy="${py}" r="2.5" fill="${color}"/>`);
        }
      }
    });
  }

  // 类目名：太密就隔几个画一个
  const step = Math.ceil(n / Math.max(1, Math.floor(pw / 44)));
  chart.cats.forEach((c, i) => {
    if (i % step !== 0) return;
    if (horizontal) {
      part.push(`<text x="${padL - 4}" y="${(padT + (ph * (i + 0.5)) / n + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#595959">${esc(c.slice(0, 8))}</text>`);
    } else {
      part.push(`<text x="${(padL + (pw * (i + 0.5)) / n).toFixed(1)}" y="${h - 6}" text-anchor="middle" font-size="9" fill="#595959">${esc(c.slice(0, 8))}</text>`);
    }
  });

  const title = chart.title
    ? `<text x="${padL}" y="16" font-size="12" font-weight="600" fill="#1f2430">${esc(chart.title)}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${title}${part.join("")}</svg>`;
}

function pie(chart: SheetChart, w: number, h: number): string {
  const values = chart.series[0]?.values ?? [];
  const total = values.reduce<number>((a, v) => a + (typeof v === "number" ? Math.abs(v) : 0), 0) || 1;
  const legend = w > 200;
  const boxW = legend ? w * 0.62 : w;
  const cx = boxW / 2;
  const cy = h / 2 + (chart.title ? 6 : 0);
  const r = Math.max(8, Math.min(boxW, h) / 2 - 14);
  let angle = -Math.PI / 2;
  const part: string[] = [];
  values.forEach((v, i) => {
    const frac = (typeof v === "number" ? Math.abs(v) : 0) / total;
    if (frac <= 0) return;
    const end = angle + frac * Math.PI * 2;
    const x0 = cx + r * Math.cos(angle);
    const y0 = cy + r * Math.sin(angle);
    const x1 = cx + r * Math.cos(end);
    const y1 = cy + r * Math.sin(end);
    const large = frac > 0.5 ? 1 : 0;
    part.push(`<path d="M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" fill="${PALETTE[i % PALETTE.length]}" stroke="#fff" stroke-width="1"/>`);
    angle = end;
  });
  if (legend) {
    const rows = Math.min(values.length, 10);
    const top = Math.max(10, (h - rows * 16) / 2);
    values.slice(0, rows).forEach((_, i) => {
      const yy = top + i * 16;
      part.push(`<rect x="${boxW + 4}" y="${yy}" width="9" height="9" fill="${PALETTE[i % PALETTE.length]}"/>`);
      part.push(`<text x="${boxW + 18}" y="${yy + 8}" font-size="10" fill="#404040">${esc((chart.cats[i] ?? "").slice(0, 10))}</text>`);
    });
  }
  const title = chart.title
    ? `<text x="8" y="16" font-size="12" font-weight="600" fill="#1f2430">${esc(chart.title)}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${title}${part.join("")}</svg>`;
}

/** 一张图的 DOM 节点（宽高由网格按锚点算好传进来）。 */
export function chartNode(chart: SheetChart, w: number, h: number): HTMLElement {
  const box = document.createElement("div");
  box.className = "sd-chart";
  box.style.width = `${w}px`;
  box.style.height = `${h}px`;
  box.innerHTML = chart.kind === "pie" ? pie(chart, w, h) : xy(chart, w, h);
  return box;
}
