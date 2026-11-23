/**
 * Probe: 翻译对照的并发（D392）——同一份语料，串行 vs 4 路。
 *
 * 两段：
 *   1. 桩（默认跑）：每次调用人为睡 250 ms，模拟「一个往返的固定等待」。
 *      验三件事 —— 输出与串行逐字节一致、同时在飞不超过上限、墙钟真的快 ≥2.5×。
 *   2. 真模型（`--real`）：拿 `runPiTranslate` 真跑一遍，打印每块起止、总时长、429 次数。
 *      要 provider / model：`--provider sensenova-platform --model deepseek-flash`，
 *      或环境变量 `PI_TR_PROVIDER` / `PI_TR_MODEL`。**会花钱**，所以默认只跑 2 节（6 块）。
 *
 *   node probes/translate-speed.mjs
 *   node probes/translate-speed.mjs --real --provider sensenova-platform --model deepseek-flash
 *   node probes/translate-speed.mjs --real --sections 4 --runs 3
 */
import { translateDoc, tableDiff, TR_CONCURRENCY } from "../bridge/src/translate.ts";
import { resolvePi } from "../bridge/src/pi.ts";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

/* ── 语料：每节 3 块、块够长，于是每节真的被 `packChunks` 切成 2 块以上 ───── */
const SECTIONS = Number(opt("sections", flag("real") ? 6 : 10)) || 2;
const BLOCK = Number(opt("block", 1500)) || 300;
const corpus = Array.from({ length: SECTIONS }, (_, si) =>
  [
    `## 節${si}`,
    "",
    `B${si}-0 alpha beta gamma delta. `.repeat(Math.ceil(BLOCK / 30)),
    "",
    `B${si}-1 epsilon zeta eta theta. `.repeat(Math.ceil(BLOCK / 29)),
    "",
    `B${si}-2 iota kappa lambda mu. `.repeat(Math.ceil(BLOCK / 26)),
    "",
  ].join("\n"),
).join("\n");

const run = { cli: "x.js", cwd: ".", lang: "zh", provider: "p", model: "m", fast: true, backoffMs: 0 };
/** 假模型：每行加「译:」；真模型与它不一样，但「按位置拼回去」的判据是一样的。 */
const stub = async (chunk) =>
  chunk
    .split("\n")
    .map((l) => (l.trim() ? `译:${l}` : l))
    .join("\n");

/* ── 1. 桩：串行 vs 4 路 ─────────────────────────────────────────────── */
const LATENCY = Number(opt("latency", 250));
let live = 0;
let peak = 0;
let calls = 0;
const slow = async (chunk) => {
  calls++;
  live++;
  peak = Math.max(peak, live);
  await new Promise((r) => setTimeout(r, LATENCY));
  live--;
  return stub(chunk);
};

console.log(`\n桩：${SECTIONS} 节，每次调用睡 ${LATENCY} ms\n`);
const t0 = performance.now();
const serial = await translateDoc(corpus, run, slow, { limit: 1 });
const serialMs = performance.now() - t0;
const serialCalls = calls;
peak = 0;
calls = 0;
const t1 = performance.now();
const conc = await translateDoc(corpus, run, slow, { limit: TR_CONCURRENCY });
const concMs = performance.now() - t1;
const concCalls = calls;

console.log(`  串行   ${secs(serialMs)}  （${serialCalls} 次调用，peak 1）`);
console.log(`  4 路   ${secs(concMs)}  （${concCalls} 次调用，peak ${peak}）`);
console.log(`  倍数   ×${(serialMs / concMs).toFixed(2)}\n`);

check("并发与串行输出逐节一致", conc.sections.length === serial.sections.length && conc.sections.every((s, i) => s.out === serial.sections[i].out), `${serial.sections.length} 节`);
check("块数一次不少", concCalls === serialCalls, `${serialCalls} vs ${concCalls}`);
if (SECTIONS >= 10) check("语料够长（≥ 20 块）", serialCalls >= 20, `${serialCalls} 块`);
check("同时在飞不超过上限", peak <= TR_CONCURRENCY, `peak ${peak}`);
check("墙钟至少快 2.5×", serialMs / concMs >= 2.5, `×${(serialMs / concMs).toFixed(2)}`);

/* ── 2. 桩：撞一次 429 仍然翻完（退避在并发下也要走通） ─────────────── */
const limited = (() => {
  let n = 0;
  return async (chunk) => {
    if (n++ === 0) throw new Error('429 {"message":"inference exceeds tpm/rpm limit","type":"rate_limit_error"}');
    return stub(chunk);
  };
})();
const t2 = performance.now();
const recovered = await translateDoc(corpus, run, limited, { limit: TR_CONCURRENCY });
check("撞一次 429 之后整篇仍然翻完", recovered.failures.length === 0 && recovered.sections.length === SECTIONS, `${secs(performance.now() - t2)}`);

/* ── 3. 真模型（可选） ────────────────────────────────────────────────── */
if (!flag("real")) {
  console.log("\n（真模型那一段要 --real；会花钱，默认不跑）");
} else {
  const provider = opt("provider", process.env.PI_TR_PROVIDER ?? "");
  const model = opt("model", process.env.PI_TR_MODEL ?? "");
  const runs = Number(opt("runs", 1)) || 1;
  if (!provider || !model) {
    console.log("\n跳过真模型：给 --provider / --model，或设 PI_TR_PROVIDER / PI_TR_MODEL。");
  } else {
    const { cli } = resolvePi();
    const real = { cli, cwd: ".", lang: "zh", provider, model, fast: !flag("with-extensions"), backoffMs: 1500 };
    const { runPiTranslate } = await import("../bridge/src/translate.ts");
    const bills = { n: 0, rate: 0 };
    const timed = async (chunk, o, kind, signal) => {
      bills.n++;
      const at = performance.now();
      try {
        const out = await runPiTranslate(chunk, o, kind, signal);
        console.log(`     ${secs(performance.now() - at).padStart(7)}  ${chunk.slice(0, 28).replace(/\s+/g, " ")}…`);
        return out;
      } catch (e) {
        if (/429|rate.?limit|RPM/i.test(String(e?.message ?? e))) bills.rate++;
        console.log(`     429/错误 ${secs(performance.now() - at)} ${String(e?.message ?? e).slice(0, 60)}`);
        throw e;
      }
    };

    console.log(`\n真模型：${provider}/${model}，${SECTIONS} 节，每档跑 ${runs} 遍\n`);
    const medians = { serial: [], conc: [] };
    let realSerial = null;
    let realConc = null;
    for (let r = 0; r < runs; r++) {
      console.log(`  第 ${r + 1} 遍 · 串行`);
      const at = performance.now();
      realSerial = await translateDoc(corpus, real, timed, { limit: 1 });
      medians.serial.push(performance.now() - at);
      console.log(`    → ${secs(medians.serial.at(-1))}`);
      console.log(`  第 ${r + 1} 遍 · ${TR_CONCURRENCY} 路`);
      const cAt = performance.now();
      realConc = await translateDoc(corpus, real, timed, { limit: TR_CONCURRENCY });
      medians.conc.push(performance.now() - cAt);
      console.log(`    → ${secs(medians.conc.at(-1))}`);
    }
    const mid = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const sMs = mid(medians.serial);
    const cMs = mid(medians.conc);

    console.log(`\n  串行中位  ${secs(sMs)}`);
    console.log(`  4 路中位  ${secs(cMs)}`);
    console.log(`  倍数      ×${(sMs / cMs).toFixed(2)}   调用 ${bills.n} 次，其中限流 ${bills.rate} 次\n`);

    // 真模型不是确定性的：两次的措辞本来就不一样，所以只比结构（节数 / 标题 / 表格形状），
    // 不比文字。
    const sameShape =
      realConc.sections.length === realSerial.sections.length &&
      realConc.sections.every((s, i) => s.heading === realSerial.sections[i].heading && tableDiff(s.src, s.out) === null);
    check("真模型下结构一致（节数 / 标题 / 表格形状）", sameShape, `${realSerial.sections.length} 节`);
    check("真模型下没翻成的块为 0", realConc.failures.length === 0, JSON.stringify(realConc.failures.slice(0, 2)));
    // 绝对秒数只作参考（D392 的验收线是相对倍数），所以这里只报不断言。
    console.log(`  参考：绝对秒数随模型与 provider 波动很大，验收只看上面的倍数。`);
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed ? `${failed} 处失败` : "全部通过"}（${results.length} 项）`);
process.exit(failed ? 1 : 0);
