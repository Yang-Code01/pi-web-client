// 截图检查：模型 chip（模型 · 上下文 · tok/s · thinking）在输入框那一行的布局
// 用法：node probes/chip-shot.mjs [sessionId]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Browser, sleep } from "file:///C:/Users/GG_Bond/.pi/agent/bin/lib/cdp.mjs";

const BASE = "http://127.0.0.1:7864";
const STATE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local/share"), "pi-web-client");
const PASS = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
const OUT = path.join(import.meta.dirname, "out");
fs.mkdirSync(OUT, { recursive: true });
const want = process.argv[2];

const b = await Browser.launch({ width: 1440, height: 900 });

async function shot(page, name, clip) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, format: "png", clip });
  console.log("shot:", file);
}

for (const [name, vp] of [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844, mobile: true }],
]) {
  const page = await b.newPage(vp);
  await page.goto(`${BASE}/`, { settleMs: 800 });

  // 登录（已登录时输入框不存在，直接跳过）
  await page.eval(async (pass) => {
    const input = document.querySelector(".login input");
    if (!input) return "already";
    input.value = pass;
    document.querySelector(".login form").requestSubmit();
    return "submitted";
  }, PASS);
  await sleep(1500);

  // 进一个有消息的会话
  const id = await page.eval(async (wanted) => {
    const cards = [...document.querySelectorAll(".session-card")];
    if (!cards.length) return null;
    const card = wanted ? cards.find((c) => (c.textContent || "").includes(wanted)) ?? cards[0] : cards[0];
    card.click();
    return (location.hash.match(/s\/([0-9a-f-]+)/) || [])[1] ?? "clicked";
  }, want);
  console.log(name, "session:", id);
  await sleep(2000);

  const info = await page.eval(() => {
    const chip = document.querySelector(".model-chip");
    const hud = document.querySelector(".hud");
    const cs = chip ? getComputedStyle(chip) : null;
    const r = chip?.getBoundingClientRect();
    const composer = document.querySelector(".composer")?.getBoundingClientRect();
    return {
      chipText: chip?.textContent,
      chipTitle: chip?.title,
      chipRect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
      chipPosition: cs?.position,
      chipSegments: [...(chip?.children ?? [])].map((s) => ({ cls: s.className, text: s.textContent })),
      floatingHud: hud ? getComputedStyle(hud).position : "absent",
      composerRect: composer ? { y: Math.round(composer.y), h: Math.round(composer.height) } : null,
      vw: innerWidth,
      vh: innerHeight,
      docOverflowX: document.documentElement.scrollWidth > innerWidth,
    };
  });
  console.log(name, JSON.stringify(info, null, 1));

  await shot(page, `${name}-full`);
  const chip = info.chipRect;
  if (chip) {
    await shot(page, `${name}-composer`, {
      x: 0,
      y: Math.max(0, Math.round(info.composerRect.y) - 10),
      width: info.vw,
      height: Math.min(info.vh - Math.max(0, Math.round(info.composerRect.y) - 10), Math.round(info.composerRect.h) + 30),
    });
  }
  const errs = await page.eval(() => window.__errs ?? []);
  await page.close();
}

await b.close();
console.log("done");
