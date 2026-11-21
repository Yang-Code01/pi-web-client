/**
 * Render the standalone report. No framework, no network, no build step:
 * the CSS and JS live in this file, the videos and VTTs sit next to the HTML.
 */

const STATUS_LABEL = {
  pass: "通过",
  fail: "未通过",
  error: "执行出错",
  missing: "缺失"
};

const VERDICT_LABEL = {
  pass: "两侧都通过",
  fixed: "已修复",
  regressed: "回归",
  "both-fail": "仍未通过",
  "missing-before": "缺少修改前",
  "missing-after": "缺少修改后",
  missing: "缺少两侧"
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}

function attr(value) {
  return esc(value);
}

function tfmt(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const rest = value - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function localTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function badge(status) {
  const key = STATUS_LABEL[status] ? status : "missing";
  return `<span class="badge badge-${key}">${STATUS_LABEL[key]}</span>`;
}

function verdictBadge(verdict) {
  const key = VERDICT_LABEL[verdict] ? verdict : "missing";
  return `<span class="badge verdict-${key}">${VERDICT_LABEL[key]}</span>`;
}

function gitLine(git) {
  if (!git) return "未记录";
  const branch = git.branch || "(detached)";
  const head = git.head || git.headFull?.slice(0, 9) || "?";
  return `${branch} @ ${head}`;
}

function envLine(env) {
  if (!env) return "未记录";
  return env.url || env.baseUrl || "未记录";
}

function htmlOrText(html, text, fallback) {
  if (html) return `<div class="prose">${html}</div>`;
  if (text) return `<pre class="prose pre">${esc(text)}</pre>`;
  return `<p class="muted">${esc(fallback)}</p>`;
}

function videoTag(side, options = {}) {
  if (!side?.video) {
    return `<div class="video-missing">未生成视频${side?.error ? `：${esc(side.error)}` : ""}</div>`;
  }
  const track = side.vtt
    ? `<track kind="captions" srclang="zh" label="中文" src="${attr(side.vtt)}" default>`
    : "";
  const id = options.id ? ` id="${attr(options.id)}"` : "";
  const sideAttr = options.side ? ` data-side="${attr(options.side)}"` : "";
  const muted = options.muted ? " muted" : "";
  const poster = side.poster ? ` poster="${attr(side.poster)}"` : "";
  return (
    `<video${id}${sideAttr} controls preload="metadata" playsinline${muted}${poster}>` +
    `<source src="${attr(side.video)}" type="video/mp4">${track}</video>`
  );
}

function stepsList(steps, targetId) {
  if (!steps?.length) return `<p class="muted">没有步骤记录。</p>`;
  const items = steps
    .map((step, index) => {
      const t = Number(step.tFinal ?? step.t ?? 0);
      const title = step.title || step.caption || `步骤 ${index + 1}`;
      const audio = step.audioDuration ? ` · 旁白 ${Number(step.audioDuration).toFixed(1)}s` : "";
      return (
        `<li>` +
        `<button class="step-row" data-seek="${attr(t.toFixed(3))}" data-target="${attr(targetId)}">` +
        `<span class="step-time">${tfmt(t)}</span>` +
        `<span class="step-index">${String(index + 1).padStart(2, "0")}</span>` +
        `<span class="step-title">${esc(title)}</span>` +
        `<span class="step-note">${esc(audio)}</span>` +
        `</button></li>`
      );
    })
    .join("");
  return `<ol class="steps-list">${items}</ol>`;
}

function stepChips(item) {
  const after = item.after?.steps || [];
  const before = item.before?.steps || [];
  const count = Math.max(after.length, before.length);
  if (count === 0) return "";
  const chips = [];
  for (let index = 0; index < count; index += 1) {
    const a = after[index];
    const b = before[index];
    const title = a?.title || b?.title || `步骤 ${index + 1}`;
    const beforeT = b ? Number(b.tFinal ?? b.t ?? 0) : null;
    const afterT = a ? Number(a.tFinal ?? a.t ?? 0) : null;
    const dataBefore = beforeT == null ? "" : ` data-before="${attr(beforeT.toFixed(3))}"`;
    const dataAfter = afterT == null ? "" : ` data-after="${attr(afterT.toFixed(3))}"`;
    chips.push(
      `<button class="chip"${dataBefore}${dataAfter}>` +
        `<span>${String(index + 1).padStart(2, "0")}</span>${esc(title)}` +
        `</button>`
    );
  }
  return `<div class="chips">${chips.join("")}</div>`;
}

function sidePanel(item, sideName, label) {
  const side = item[sideName];
  const video = side
    ? videoTag(side, { side: sideName, muted: sideName === "before" })
    : `<div class="video-missing">没有${label}录制</div>`;
  const status = side?.status ? badge(side.status) : badge("missing");
  const meta = side
    ? `${tfmt(side.tFinalStart)} – ${tfmt(side.tFinalEnd)} · ${side.steps?.length || 0} 步 · ${formatBytes(side.bytes)}`
    : "—";
  return (
    `<div class="side">` +
    `<div class="side-head"><h3>${esc(label)}</h3>${status}</div>` +
    `<div class="side-meta">${esc(meta)}</div>` +
    video +
    (sideName === "before"
      ? `<p class="muted tiny">修改前默认静音，避免两段旁白同时响；需要时可点播放器音量打开。</p>`
      : "") +
    `</div>`
  );
}

function caseCard(item, index) {
  const domId = `case-${index + 1}`;
  const max = Math.max(item.before?.duration || 0, item.after?.duration || 0);
  return (
    `<article class="case" id="${domId}" data-case="${attr(item.id)}">` +
    `<header class="case-head">` +
    `<div class="case-title"><span class="case-no">${String(index + 1).padStart(2, "0")}</span>` +
    `<h2>${esc(item.title || item.id)}</h2>${verdictBadge(item.verdict)}</div>` +
    (item.expect ? `<p class="case-expect">期望：${esc(item.expect)}</p>` : "") +
    `</header>` +
    `<div class="case-controls">` +
    `<button class="btn" data-sync-play>同步播放</button>` +
    `<button class="btn ghost" data-sync-pause>暂停</button>` +
    `<label class="speed">速度 <select data-speed>` +
    `<option value="0.5">0.5×</option><option value="0.75">0.75×</option>` +
    `<option value="1" selected>1×</option><option value="1.5">1.5×</option><option value="2">2×</option>` +
    `</select></label>` +
    `<span class="timecode" data-time>前 00:00.0 / 后 00:00.0</span>` +
    `<span class="muted tiny">总时长 ${tfmt(max)}</span>` +
    `</div>` +
    stepChips(item) +
    `<div class="compare">${sidePanel(item, "before", "修改前")}${sidePanel(item, "after", "修改后")}</div>` +
    `<details class="asserts"><summary>断言与错误</summary>${assertBlock(item)}</details>` +
    `</article>`
  );
}

function assertBlock(item) {
  const rows = [];
  for (const sideName of ["before", "after"]) {
    const side = item[sideName];
    if (!side) continue;
    const asserts = side.asserts || [];
    const errors = side.errors || [];
    if (asserts.length === 0 && errors.length === 0) continue;
    rows.push(`<h4>${sideName === "before" ? "修改前" : "修改后"}</h4>`);
    if (asserts.length) {
      rows.push(
        `<ul class="assert-list">` +
          asserts
            .map(
              (assertion) =>
                `<li class="${assertion.pass ? "ok" : "bad"}">` +
                `<span>${assertion.pass ? "通过" : "失败"}</span>` +
                `${esc(assertion.desc)}` +
                (assertion.pass
                  ? ""
                  : `<small>实际 ${esc(assertion.actual)} / 期望 ${esc(assertion.expected)}</small>`) +
                `</li>`
            )
            .join("") +
          `</ul>`
      );
    }
    for (const error of errors) {
      rows.push(`<pre class="error">${esc(error.message || error.stack || String(error))}</pre>`);
    }
  }
  return rows.length ? rows.join("") : `<p class="muted">没有断言或错误记录。</p>`;
}

function coverageTable(coverage) {
  const list = Array.isArray(coverage) ? coverage : [];
  if (list.length === 0) return `<p class="muted">未提供覆盖矩阵。</p>`;
  const rows = list
    .map((item) => {
      if (typeof item === "string") {
        return `<tr><td>${esc(item)}</td><td>—</td><td></td></tr>`;
      }
      const status = item.status || item.state || "—";
      return (
        `<tr><td>${esc(item.item || item.name || "")}</td>` +
        `<td>${esc(status)}</td><td>${esc(item.note || "")}</td></tr>`
      );
    })
    .join("");
  return `<div class="table-wrap"><table class="table"><thead><tr><th>变更点</th><th>状态</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function uncoveredBlock(uncovered) {
  if (!uncovered) return "";
  if (Array.isArray(uncovered)) {
    if (uncovered.length === 0) return `<p class="muted">没有未覆盖项。</p>`;
    return `<ul class="plain-list">${uncovered.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
  }
  return `<pre class="prose pre">${esc(uncovered)}</pre>`;
}

function resultTable(cases) {
  if (cases.length === 0) return `<p class="muted">没有用例结果。</p>`;
  const rows = cases
    .map(
      (item, index) =>
        `<tr>` +
        `<td><a href="#case-${index + 1}">${esc(item.title || item.id)}</a></td>` +
        `<td>${item.before ? badge(item.before.status) : badge("missing")}</td>` +
        `<td>${item.after ? badge(item.after.status) : badge("missing")}</td>` +
        `<td>${verdictBadge(item.verdict)}</td>` +
        `<td class="muted">${esc(item.expect || "")}</td>` +
        `</tr>`
    )
    .join("");
  return (
    `<div class="table-wrap"><table class="table">` +
    `<thead><tr><th>用例</th><th>修改前</th><th>修改后</th><th>判定</th><th>期望</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div>`
  );
}

function logsBlock(side) {
  const consoleErrors = (side?.console || []).filter((item) => item.type === "error");
  const networkErrors = (side?.network || []).filter(
    (item) => item.status === 0 || item.status >= 400
  );
  if (consoleErrors.length === 0 && networkErrors.length === 0) {
    return `<p class="muted">没有采集到控制台错误或失败请求。</p>`;
  }
  const rows = [];
  for (const item of consoleErrors) {
    rows.push(`<li class="bad"><span>console.${esc(item.type)}</span>${esc(item.text)}</li>`);
  }
  for (const item of networkErrors) {
    rows.push(
      `<li class="bad"><span>HTTP ${esc(item.status)}</span>${esc(item.method)} ${esc(item.url)}</li>`
    );
  }
  return `<ul class="assert-list">${rows.join("")}</ul>`;
}

function appendix(spec) {
  const sides = Object.values(spec.sides || {});
  const after = spec.sides?.after;
  const before = spec.sides?.before;
  const files = [
    `<a href="spec.json">spec.json</a>`,
    `<a href="run.log">run.log</a>`,
    spec.caseFile ? `<a href="${attr(spec.caseFile)}">用例脚本</a>` : "",
    after?.video ? `<a href="${attr(after.video)}">修改后完整视频</a>` : "",
    before?.video ? `<a href="${attr(before.video)}">修改前完整视频</a>` : ""
  ].filter(Boolean);
  return (
    `<section id="appendix" class="section">` +
    `<div class="section-kicker">附录</div><h2>环境与证据</h2>` +
    `<div class="grid-2">` +
    `<div class="panel"><h3>代码版本</h3><dl class="kv">` +
    `<dt>修改前</dt><dd>${esc(gitLine(spec.git?.before))}</dd>` +
    `<dt>修改后</dt><dd>${esc(gitLine(spec.git?.after))}</dd>` +
    `<dt>生成时间</dt><dd>${esc(localTime(spec.generatedAt))}</dd>` +
    `</dl></div>` +
    `<div class="panel"><h3>测试环境</h3><dl class="kv">` +
    `<dt>修改前</dt><dd>${esc(envLine(spec.env?.before))}</dd>` +
    `<dt>修改后</dt><dd>${esc(envLine(spec.env?.after))}</dd>` +
    `<dt>录制</dt><dd>${esc(String(spec.fps || 25))} fps · ${esc(after?.duration ? `${after.duration.toFixed(1)}s` : "—")}</dd>` +
    `<dt>视频体积</dt><dd>${formatBytes(sides.reduce((sum, side) => sum + (Number(side.bytes) || 0), 0))}</dd>` +
    `<dt>运行命令</dt><dd><code class="cmd">${esc(spec.command || "—")}</code></dd>` +
    `</dl></div>` +
    `</div>` +
    `<div class="panel"><h3>文件</h3><p class="file-links">${files.join(" · ")}</p>` +
    `<details><summary>修改后：控制台与网络</summary>${logsBlock(after)}</details>` +
    (before ? `<details><summary>修改前：控制台与网络</summary>${logsBlock(before)}</details>` : "") +
    `</div>` +
    `</section>`
  );
}

function hero(spec, mode) {
  const meta = spec.meta || {};
  const kicker = mode === "bug" ? "BUG 复现" : "变更验收";
  const title = meta.title || spec.title || "pi-web-e2e-test";
  const lede =
    meta.summary ||
    (mode === "bug"
      ? "按复现手顺录制，点击与特殊操作均有红框 / 标记；关键瞬间自动慢放。"
      : "同一套用例在修改前、修改后各录一遍，并排对照。");
  const afterGit = spec.git?.after;
  const beforeGit = spec.git?.before;
  const sides = Object.values(spec.sides || {});
  const totalBytes = sides.reduce((sum, side) => sum + (Number(side.bytes) || 0), 0);
  const totalDuration = sides.reduce((max, side) => Math.max(max, Number(side.duration) || 0), 0);
  const chips = [
    `<span class="pill">${esc(kicker)}</span>`,
    afterGit ? `<span class="pill">修改后 ${esc(afterGit.branch || "detached")} @ ${esc(afterGit.head || "?")}</span>` : "",
    beforeGit ? `<span class="pill">修改前 ${esc(beforeGit.head || "?")}</span>` : "",
    spec.meta?.issue ? `<a class="pill link" href="${attr(spec.meta.issue)}">Issue</a>` : ""
  ].filter(Boolean);
  return (
    `<header class="hero">` +
    `<div class="hero-top">${chips.join("")}</div>` +
    `<h1>${esc(title)}</h1>` +
    `<p class="lede">${esc(lede)}</p>` +
    `<div class="hero-stats">` +
    `<span><b>${(spec.cases || []).length}</b> 条用例</span>` +
    `<span><b>${esc(afterGit ? afterGit.head || "?" : "—")}</b> 修改后 HEAD</span>` +
    `<span><b>${esc(localTime(spec.generatedAt))}</b> 生成</span>` +
    `<span><b>${formatBytes(totalBytes)}</b> 视频体积</span>` +
    `<span><b>${tfmt(totalDuration)}</b> 总时长</span>` +
    `</div>` +
    `</header>`
  );
}

function bugBody(spec) {
  const meta = spec.meta || {};
  const beforeSides = spec.sides?.before;
  const primary = spec.sides?.after || spec.sides?.before;
  const video = primary?.video
    ? videoTag(primary, { id: "full-video" })
    : `<div class="video-missing">没有生成视频。${esc(primary?.error || "")}</div>`;
  const symptom =
    meta.symptomHtml ||
    (meta.symptom ? `<pre class="prose pre">${esc(meta.symptom)}</pre>` : "");
  const expected = meta.expected || "";
  const actual = meta.actual || "";
  return (
    `<main>` +
    `<section class="section" id="symptom">` +
    `<div class="section-kicker">01 · 现象</div><h2>${esc(meta.symptomTitle || "看到的异常")}</h2>` +
    (symptom || `<p class="prose">${esc(meta.summary || "见复现视频。")}</p>`) +
    `<div class="grid-2">` +
    `<div class="panel expect"><h3>期望</h3><p>${esc(expected || "（未填写）")}</p></div>` +
    `<div class="panel actual"><h3>实际</h3><p>${esc(actual || "（未填写）")}</p></div>` +
    `</div>` +
    `</section>` +
    `<section class="section" id="repro">` +
    `<div class="section-kicker">02 · 复现手顺</div><h2>逐步复现</h2>` +
    `<p class="section-lede">点击任意步骤可跳到对应时间；红框是点击目标，键帽是按键，黄色徽标是慢放瞬间。</p>` +
    video +
    stepsList(primary?.steps || [], "full-video") +
    `</section>` +
    `<section class="section" id="cause">` +
    `<div class="section-kicker">03 · 原因</div><h2>根因</h2>` +
    htmlOrText(meta.causeHtml, meta.cause, "未提供原因分析。") +
    `</section>` +
    `<section class="section" id="fix">` +
    `<div class="section-kicker">04 · 修改方案</div><h2>建议改法</h2>` +
    htmlOrText(meta.fixHtml, meta.fix, "未提供修改方案。方案只写在这里，未落盘。") +
    `<p class="callout">此页只给方案，不改代码；方案未落盘。真正实施前请先确认范围与风险。</p>` +
    `</section>` +
    `<section class="section" id="evidence">` +
    `<div class="section-kicker">05 · 证据</div><h2>录制与断言</h2>` +
    `<details class="asserts" open><summary>修改前 / 修改后对照侧</summary>` +
    (beforeSides
      ? `<p class="muted">本页同时存在修改前录制：${esc(gitLine(spec.git?.before))} → ${esc(gitLine(spec.git?.after))}</p>`
      : `<p class="muted">没有修改前录制；本页展示当前复现。</p>`) +
    `</details>` +
    `<div class="grid-2">` +
    `<div class="panel"><h3>修改后断言</h3>${assertBlock({ after: spec.sides?.after })}</div>` +
    `<div class="panel"><h3>修改后控制台 / 网络</h3>${logsBlock(spec.sides?.after)}</div>` +
    `</div>` +
    `</section>` +
    appendix(spec) +
    `</main>`
  );
}

function changeBody(spec) {
  const meta = spec.meta || {};
  const cases = spec.cases || [];
  const summary = meta.summaryHtml || (meta.summary ? `<p class="prose">${esc(meta.summary)}</p>` : "");
  const source = meta.sourceHtml || (meta.source ? `<pre class="prose pre">${esc(meta.source)}</pre>` : "");
  return (
    `<main>` +
    `<section class="section" id="summary">` +
    `<div class="section-kicker">01 · 变更</div><h2>${esc(meta.changeTitle || "改了什么")}</h2>` +
    (summary || `<p class="muted">未提供变更摘要。</p>`) +
    (source ? `<details class="asserts" open><summary>来源与依据</summary>${source}</details>` : "") +
    `</section>` +
    `<section class="section" id="verdict">` +
    `<div class="section-kicker">02 · 结论</div><h2>逐条判定</h2>` +
    resultTable(cases) +
    `</section>` +
    `<section class="section" id="cases">` +
    `<div class="section-kicker">03 · 用例</div><h2>修改前后对照</h2>` +
    `<p class="section-lede">两侧默认同步播放；点步骤 chip 会分别跳到该步在两侧的时间。修改前默认静音，避免两段旁白叠在一起。</p>` +
    (cases.length ? cases.map(caseCard).join("") : `<p class="muted">没有用例。</p>`) +
    `</section>` +
    `<section class="section" id="coverage">` +
    `<div class="section-kicker">04 · 覆盖</div><h2>覆盖矩阵</h2>` +
    coverageTable(meta.coverage) +
    `<h3>未覆盖</h3>` +
    uncoveredBlock(meta.uncovered) +
    `</section>` +
    appendix(spec) +
    `</main>`
  );
}

const CSS = `
:root{color-scheme:light;--ink:#1c1b19;--muted:#6f6a62;--line:#ded8cc;--paper:#faf8f3;--card:#fffdf8;--red:#c4312d;--green:#1d7a56;--amber:#a66312;--blue:#2d5f8a}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.65 "Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--blue)}a:hover{text-decoration-thickness:2px}
.hero{max-width:1180px;margin:0 auto;padding:56px 28px 28px}
.hero-top{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}
.pill{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;padding:4px 11px;font-size:12px;letter-spacing:.04em;color:var(--muted);background:var(--card);text-decoration:none}
.pill.link:hover{border-color:var(--blue);color:var(--blue)}
.hero h1{font-size:clamp(30px,4.6vw,52px);line-height:1.08;letter-spacing:-.035em;margin:0 0 14px;max-width:900px}
.lede{font-size:18px;color:var(--muted);max-width:780px;margin:0 0 22px}
.hero-stats{display:flex;flex-wrap:wrap;gap:22px;border-top:1px solid var(--line);padding-top:16px;color:var(--muted);font-size:13px}
.hero-stats b{color:var(--ink);font-variant-numeric:tabular-nums}
main{max-width:1180px;margin:0 auto;padding:0 28px 90px}
.section{padding:42px 0 8px;border-top:1px solid var(--line);margin-top:28px}
.section-kicker{font:12px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
.section h2{font-size:clamp(22px,2.4vw,30px);letter-spacing:-.02em;margin:0 0 12px}
.section h3{font-size:16px;margin:18px 0 8px}
.section-lede{color:var(--muted);margin:0 0 16px;max-width:820px}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px}
.panel h3{margin:0 0 8px;font-size:14px;letter-spacing:.02em}
.panel.expect{border-left:3px solid var(--green)}
.panel.actual{border-left:3px solid var(--red)}
.prose{margin:0 0 12px;max-width:900px}
.pre{white-space:pre-wrap;word-break:break-word;font:13px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;background:#f3f0e9;border:1px solid var(--line);border-radius:8px;padding:12px}
.muted{color:var(--muted)}.tiny{font-size:12px;line-height:1.5}
.callout{border-left:3px solid var(--amber);background:#fbf3e5;padding:10px 14px;color:#5e461d;border-radius:0 8px 8px 0}
.badge{display:inline-flex;align-items:center;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:650;letter-spacing:.03em;white-space:nowrap}
.badge-pass,.verdict-pass{background:#e3f3eb;color:var(--green)}
.badge-fail,.verdict-regressed,.verdict-both-fail{background:#fbe7e5;color:var(--red)}
.badge-error{background:#fbf0dc;color:var(--amber)}
.badge-missing,.verdict-missing,.verdict-missing-before,.verdict-missing-after{background:#eeeae2;color:var(--muted)}
.verdict-fixed{background:#e6eff8;color:var(--blue)}
.video-missing{display:flex;align-items:center;justify-content:center;min-height:220px;border:1px dashed var(--line);border-radius:10px;background:#f3f0e9;color:var(--muted);font-size:13px;text-align:center;padding:20px}
video{display:block;width:100%;aspect-ratio:16/10;background:#0d0d0d;border-radius:10px;border:1px solid var(--line)}
.case{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin:18px 0 26px}
.case-head{margin-bottom:12px}
.case-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.case-title h2{font-size:20px;margin:0;letter-spacing:-.01em}
.case-no{font:12px/1 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted)}
.case-expect{margin:8px 0 0;color:var(--muted);font-size:14px}
.case-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin:10px 0}
.btn{appearance:none;border:1px solid var(--ink);background:var(--ink);color:#fff;border-radius:8px;padding:7px 13px;font:13px/1 inherit;cursor:pointer}
.btn:hover{opacity:.85}
.btn.ghost{background:transparent;color:var(--ink)}
.speed{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:5px}
select{font:12px/1 inherit;padding:5px 7px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink)}
.timecode{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted);margin-left:auto}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 14px}
.chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:#fff;border-radius:999px;padding:5px 11px 5px 7px;font:12px/1.2 inherit;color:var(--ink);cursor:pointer;max-width:100%;text-align:left}
.chip span{display:inline-flex;align-items:center;justify-content:center;min-width:19px;height:19px;border-radius:999px;background:#eeeae2;color:var(--muted);font:10px ui-monospace,SFMono-Regular,Consolas,monospace}
.chip:hover{border-color:var(--ink)}
.chip.active{border-color:var(--ink);background:var(--ink);color:#fff}
.chip.active span{background:#fff;color:var(--ink)}
.cmd{font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all;background:#f2efe8;border:1px solid var(--line);border-radius:6px;padding:2px 6px}
.compare{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.side{min-width:0}
.side-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:3px}
.side-head h3{margin:0;font-size:14px}
.side-meta{font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted);margin-bottom:7px}
.steps-list{list-style:none;margin:14px 0 0;padding:0;border-top:1px solid var(--line)}
.step-row{display:grid;grid-template-columns:64px 34px 1fr auto;gap:8px;align-items:center;width:100%;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--ink);padding:9px 4px;text-align:left;font:14px/1.35 inherit;cursor:pointer}
.step-row:hover{background:#f5f1e8}
.step-time{font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted)}
.step-index{font:10px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted)}
.step-title{font-weight:550}
.step-note{font-size:11px;color:var(--muted)}
details.asserts{margin-top:16px;border:1px solid var(--line);border-radius:10px;background:#fbf9f4;padding:10px 14px}
details.asserts summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--muted)}
details.asserts[open] summary{margin-bottom:8px}
.assert-list{list-style:none;margin:8px 0;padding:0;font-size:13px}
.assert-list li{display:flex;gap:9px;padding:4px 0;border-bottom:1px dotted var(--line);flex-wrap:wrap}
.assert-list li span{min-width:34px;font-size:11px;color:var(--muted)}
.assert-list li.ok span{color:var(--green)}
.assert-list li.bad span{color:var(--red)}
.assert-list small{color:var(--muted)}
.error{white-space:pre-wrap;background:#fbe7e5;border:1px solid #ecc9c4;border-radius:6px;padding:8px;font-size:12px;color:#6b211d}
.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}
.table{border-collapse:collapse;width:100%;min-width:680px;font-size:14px}
.table th,.table td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.table th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);background:#f3f0e9;position:sticky;top:0}
.table tr:last-child td{border-bottom:0}
.table a{text-decoration:none;font-weight:550}
.kv{display:grid;grid-template-columns:88px 1fr;gap:5px 12px;margin:0;font-size:13px}
.kv dt{color:var(--muted)}.kv dd{margin:0;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
.file-links{font-size:13px;line-height:1.9}
.plain-list{margin:6px 0 0;padding-left:20px;color:var(--ink)}
.footer{max-width:1180px;margin:0 auto;padding:26px 28px 60px;color:var(--muted);font-size:12px;border-top:1px solid var(--line)}
@media(max-width:860px){.grid-2,.compare{grid-template-columns:1fr}.hero{padding-top:36px}main{padding-left:18px;padding-right:18px}.hero{padding-left:18px;padding-right:18px}.case{padding:14px}.timecode{margin-left:0;width:100%}}
`;

const JS = `
(function(){
  var fmt=function(t){t=Math.max(0,Number(t)||0);var m=Math.floor(t/60);var r=t-m*60;return String(m).padStart(2,'0')+':'+r.toFixed(1).padStart(4,'0');};
  document.querySelectorAll('[data-seek]').forEach(function(btn){
    btn.addEventListener('click',function(){
      var target=document.getElementById(btn.getAttribute('data-target'));
      if(!target)return;
      var t=Number(btn.getAttribute('data-seek'))||0;
      if(target.tagName==='VIDEO'){target.currentTime=t;target.play().catch(function(){});}
    });
  });
  document.querySelectorAll('.case').forEach(function(card){
    var videos=Array.prototype.slice.call(card.querySelectorAll('video'));
    if(!videos.length)return;
    var before=card.querySelector('video[data-side="before"]');
    var after=card.querySelector('video[data-side="after"]');
    var time=card.querySelector('[data-time]');
    var speed=card.querySelector('[data-speed]');
    var syncing=false;
    function highlightChips(){
      var t=after?after.currentTime:(before?before.currentTime:0);
      var chips=Array.prototype.slice.call(card.querySelectorAll('.chip'));
      chips.forEach(function(chip,index){
        var start=Number(chip.getAttribute('data-after') || chip.getAttribute('data-before'));
        var next=chips[index+1]?Number(chips[index+1].getAttribute('data-after') || chips[index+1].getAttribute('data-before')):Infinity;
        chip.classList.toggle('active',isFinite(start)&&t>=start&&t<next);
      });
    }
    function playAll(){videos.forEach(function(v){v.play().catch(function(){});});}
    function pauseAll(){videos.forEach(function(v){v.pause();});}
    var playBtn=card.querySelector('[data-sync-play]');
    var pauseBtn=card.querySelector('[data-sync-pause]');
    if(playBtn)playBtn.addEventListener('click',playAll);
    if(pauseBtn)pauseBtn.addEventListener('click',pauseAll);
    if(speed)speed.addEventListener('change',function(){var r=Number(speed.value)||1;videos.forEach(function(v){v.playbackRate=r;});});
    videos.forEach(function(v){
      v.addEventListener('play',function(){
        if(syncing)return;
        syncing=true;
        videos.forEach(function(o){if(o!==v)o.play().catch(function(){});});
        setTimeout(function(){syncing=false;},80);
      });
      v.addEventListener('pause',function(){
        if(syncing)return;
        syncing=true;
        videos.forEach(function(o){if(o!==v)o.pause();});
        setTimeout(function(){syncing=false;},80);
      });
      v.addEventListener('timeupdate',function(){
        if(!time)return;
        time.textContent='前 '+(before?fmt(before.currentTime):'—')+' / 后 '+(after?fmt(after.currentTime):'—');
        highlightChips();
      });
    });
    card.querySelectorAll('.chip').forEach(function(chip){
      chip.addEventListener('click',function(){
        pauseAll();
        var b=chip.getAttribute('data-before');
        var a=chip.getAttribute('data-after');
        if(before&&b!==null)before.currentTime=Number(b);
        if(after&&a!==null)after.currentTime=Number(a);
        card.querySelectorAll('.chip').forEach(function(other){other.classList.toggle('active',other===chip);});
      });
    });
    highlightChips();
  });
})();
`;

function renderReport(options) {
  const spec = options.spec;
  const mode = options.mode === "bug" ? "bug" : "change";
  const title = options.title || spec.meta?.title || spec.title || "pi-web-e2e-test";
  const body = mode === "bug" ? bugBody(spec) : changeBody(spec);
  return (
    `<!doctype html><html lang="zh-CN"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title>` +
    `<style>${CSS}</style>` +
    `</head><body>` +
    hero(spec, mode) +
    body +
    `<footer class="footer">由 pi-web-e2e-test 生成 · ${esc(localTime(spec.generatedAt))} · 录屏与报告均为本地文件，视频在同目录 media/ 下。</footer>` +
    `<script>${JS}</script>` +
    `</body></html>`
  );
}

export { renderReport };
