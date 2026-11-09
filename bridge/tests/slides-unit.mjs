/**
 * Unit: 幻灯片支持里所有不需要 PowerPoint 的部分（D209）。
 *
 * 三块：
 *  1. `bridge/src/docpdf/service.ts` —— 排队 / 缓存 / 两阶段状态 / 失败记忆 / 超时 / 粗筛 / 清理。
 *     用假 driver，纯 node，不碰 LibreOffice、不碰 COM。
 *  2. `bridge/src/slides/pages.ts` —— 从中央目录数 `ppt/slides/slideN.xml`；认不出回 null（不猜）。
 *  3. `bridge/src/preview.ts` —— 分类：.pptx 是包 → slides；改了扩展名 / 加密 → binary；
 *     .ppt 老二进制照旧是 slides；pdf/docx/pptx 都拿到 /api/open 用那张 grant。
 *
 *   node --experimental-transform-types bridge/tests/slides-unit.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slides-unit-"));
process.env.PI_WEB_STATE = path.join(ROOT, "state");

const { createPdfService, PdfConvertError } = await import("../src/docpdf/service.ts");
const { countSlides } = await import("../src/slides/pages.ts");
const { openPreview } = await import("../src/preview.ts");
const { fileGrant } = await import("../src/sheet/index.ts");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 真 PDF 里一定有二进制字节（也因此会落进 binary 分支，而不是被当成 text）。
const pdfBytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from([0, 1, 2, 0xff, 0xfe, 0x80])]);

// ---------------------------------------------------------------- 假 zip

/** 最小 zip（全部 stored）：够 `countSlides` 读中央目录，不压缩、不算 CRC。 */
function zipOf(entries) {
  const local = [];
  const central = [];
  let off = 0;
  for (const [name, data] of Object.entries(entries)) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8); // store
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(body.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(body.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(off, 42);
    central.push(cd, nameBuf);

    off += lh.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([Buffer.concat(local), cdBuf, eocd]);
}

function deck(n) {
  const entries = { "[Content_Types].xml": "<Types/>", "ppt/presentation.xml": "<p/>" };
  for (let i = 1; i <= n; i++) entries[`ppt/slides/slide${i}.xml`] = "<s/>";
  entries["ppt/notesSlides/notesSlide1.xml"] = "<n/>";
  return zipOf(entries);
}

// ---------------------------------------------------------------- 1. docpdf/service

{
  const dir = path.join(ROOT, "work");
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, "deck.pptx");
  fs.writeFileSync(src, deck(3));

  let calls = 0;
  const engine = {
    label: "FakeOffice",
    convert: async (_abs, workDir) => {
      calls++;
      await sleep(30);
      const out = path.join(workDir, "out.pdf");
      fs.writeFileSync(out, pdfBytes);
      return out;
    },
  };
  const svc = createPdfService({ dir: "zz-pdf", prefix: "zz_pdf", engine });
  const mtime = fs.statSync(src).mtimeMs;

  const first = await svc.status(src, mtime);
  check("第一次问状态是 pending（转换在后台）", first.status === "pending", first.status);
  check("id 就是 keyOf", first.id === svc.keyOf(src, mtime));

  let last = first;
  for (let i = 0; i < 100 && last.status === "pending"; i++) {
    await sleep(20);
    last = await svc.status(src, mtime);
  }
  check("转完变 ready", last.status === "ready", last.status);
  const got = await svc.file(last.id);
  check("file(id) 给出真 PDF", !!got && (await fs.promises.readFile(got.file, "latin1")).startsWith("%PDF-"));
  await svc.status(src, mtime);
  check("命中缓存不再转（driver 只跑一次）", calls === 1, `calls=${calls}`);
}

{
  // 失败记忆 + 显式重试
  const dir = path.join(ROOT, "work");
  const src = path.join(dir, "deck.pptx");
  let calls = 0;
  const svc = createPdfService({
    dir: "zz-pdf-fail",
    prefix: "zz_pdf",
    engine: {
      label: "FakeOffice",
      convert: async () => {
        calls++;
        throw new PdfConvertError("slides_pdf_powerpoint", "PowerPoint 起不来");
      },
    },
  });
  const mtime = fs.statSync(src).mtimeMs;
  await svc.status(src, mtime);
  let st = { status: "pending" };
  for (let i = 0; i < 100 && st.status === "pending"; i++) {
    await sleep(15);
    st = await svc.status(src, mtime);
  }
  check("driver 抛的码原样回给页面", st.status === "failed" && st.code === "slides_pdf_powerpoint", `${st.status}/${st.code}`);
  await svc.status(src, mtime);
  await sleep(60);
  check("失败记住，不自动重试", calls === 1, `calls=${calls}`);
  await svc.status(src, mtime, true);
  await sleep(80);
  check("retry=true 才重转", calls === 2, `calls=${calls}`);
}

{
  // 超时 + kill
  const dir = path.join(ROOT, "work");
  const src = path.join(dir, "deck.pptx");
  let killed = 0;
  const svc = createPdfService({
    dir: "zz-pdf-timeout",
    prefix: "zz_pdf",
    timeoutMs: 120,
    engine: {
      label: "FakeOffice",
      kill: () => killed++,
      convert: () => new Promise(() => {}), // 永不返回
    },
  });
  const mtime = fs.statSync(src).mtimeMs;
  await svc.status(src, mtime);
  let st = { status: "pending" };
  for (let i = 0; i < 100 && st.status === "pending"; i++) {
    await sleep(20);
    st = await svc.status(src, mtime);
  }
  check("超时回 zz_pdf_timeout", st.status === "failed" && st.code === "zz_pdf_timeout", `${st.status}/${st.code}`);
  check("超时前先叫 driver 收拾进程", killed === 1, `killed=${killed}`);
}

{
  // 粗筛（页数）先于 driver，且 maxBytes 也先于 driver
  const dir = path.join(ROOT, "work");
  const src = path.join(dir, "deck.pptx");
  let calls = 0;
  const engine = { label: "FakeOffice", convert: async () => (calls++, undefined) };
  const svc = createPdfService({
    dir: "zz-pdf-pre",
    prefix: "zz_pdf",
    engine,
    precheck: async (abs) => {
      const pages = await countSlides(abs);
      return pages && pages > 2 ? { code: "slides_pdf_pages", message: `这份有 ${pages} 张` } : null;
    },
  });
  const mtime = fs.statSync(src).mtimeMs;
  await svc.status(src, mtime);
  let st = { status: "pending" };
  for (let i = 0; i < 100 && st.status === "pending"; i++) {
    await sleep(15);
    st = await svc.status(src, mtime);
  }
  check("页数粗筛先拒，driver 一次都不跑", st.status === "failed" && st.code === "slides_pdf_pages" && calls === 0, `${st.code} calls=${calls}`);

  const big = createPdfService({ dir: "zz-pdf-big", prefix: "zz_pdf", maxBytes: 4, engine });
  const st2 = await big.status(src, mtime);
  await sleep(80);
  const st3 = await big.status(src, mtime);
  check("超过体积上限直接失败", st2.status === "failed" || st3.status === "failed", st3.status);
}

{
  // 清理：保最近 2 份
  const dir = path.join(ROOT, "work");
  const svc = createPdfService({
    dir: "zz-pdf-prune",
    prefix: "zz_pdf",
    retain: { count: 2, days: 7 },
    engine: {
      label: "FakeOffice",
      convert: async (_abs, workDir) => {
        const out = path.join(workDir, "out.pdf");
        fs.writeFileSync(out, pdfBytes);
        return out;
      },
    },
  });
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const src = path.join(dir, `d${i}.pptx`);
    fs.writeFileSync(src, deck(1));
    const st = await svc.status(src, fs.statSync(src).mtimeMs);
    ids.push(st.id);
    for (let k = 0; k < 60; k++) {
      await sleep(15);
      const now = await svc.status(src, fs.statSync(src).mtimeMs);
      if (now.status !== "pending") break;
    }
    await sleep(30); // 让 prune 跑完、mtime 拉开
  }
  const left = fs.readdirSync(path.join(process.env.PI_WEB_STATE, "zz-pdf-prune")).filter((n) => n.endsWith(".pdf"));
  check("缓存只留最近 2 份", left.length === 2, `left=${left.length}`);
  check("留下的是最后两份", ids.slice(-2).every((id) => left.includes(`${id}.pdf`)), left.join(","));
}

// ---------------------------------------------------------------- 2. countSlides

{
  const dir = path.join(ROOT, "work");
  const three = path.join(dir, "three.pptx");
  fs.writeFileSync(three, deck(3));
  check("数出 3 张（notesSlides 不算）", (await countSlides(three)) === 3, String(await countSlides(three)));

  const none = path.join(dir, "no-slides.pptx");
  fs.writeFileSync(none, zipOf({ "ppt/presentation.xml": "<p/>" }));
  check("包里没有 slide → 0（不是 null）", (await countSlides(none)) === 0, String(await countSlides(none)));

  const junk = path.join(dir, "junk.pptx");
  fs.writeFileSync(junk, "this is not a zip");
  check("认不出回 null", (await countSlides(junk)) === null);
  const bin = path.join(dir, "legacy.ppt");
  fs.writeFileSync(bin, Buffer.alloc(4096, 7));
  check("没有 EOCD 回 null", (await countSlides(bin)) === null);
}

// ---------------------------------------------------------------- 3. 分类与授权

{
  const work = path.join(ROOT, "cwd");
  const jira = path.join(ROOT, "jira-dl");
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(jira, { recursive: true });
  const session = { cwd: work, file: null };
  const put = (dir, name, bytes) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, bytes);
    return p;
  };

  const good = put(work, "a.pptx", deck(2));
  const info = openPreview(session, good);
  check(".pptx 是 slides（进浮窗，不进 viewer）", info.kind === "slides", info.kind);
  check("slides 也有 /api/open 的 grant", !!fileGrant(info.token));

  const legacy = put(work, "b.ppt", Buffer.alloc(2048, 3));
  check(".ppt 老二进制照样是 slides", openPreview(session, legacy).kind === "slides");

  const ppsx = put(work, "c.ppsx", deck(1));
  check(".ppsx 是 slides", openPreview(session, ppsx).kind === "slides");

  const fake = put(work, "d.pptx", "renamed txt, not a zip");
  check("改了扩展名的不是包 → binary", openPreview(session, fake).kind === "binary");
  check("binary 也有 grant（能交给默认程序）", !!fileGrant(openPreview(session, fake).token));

  const pdf = put(work, "e.pdf", pdfBytes);
  check(".pdf 仍是 binary（D50 不变）", openPreview(session, pdf).kind === "binary");
  check(".pdf 现在也能用本机程序打开（D209 统一出口）", !!fileGrant(openPreview(session, pdf).token));

  const docx = put(work, "f.docx", zipOf({ "word/document.xml": "<d/>" }));
  check(".docx 是 binary 但有 grant", openPreview(session, docx).kind === "binary" && !!fileGrant(openPreview(session, docx).token));

  // 可信根：Jira 附件目录 / 内网通收件箱里的文件，token 绑在那个目录上（不多给一层读权）
  const inJira = put(jira, "KEY-1.pptx", deck(1));
  const pinned = openPreview(session, inJira, [jira]);
  check("登记过的根把 token 绑到那个根", pinned.root === path.resolve(jira) && pinned.rel === "KEY-1.pptx", `${pinned.root} / ${pinned.rel}`);
  const loose = openPreview(session, inJira);
  check("没登记时退回文件所在目录", loose.root === path.resolve(jira) && loose.rel === "KEY-1.pptx", loose.root);
}

// ---------------------------------------------------------------- 收尾

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ok`);
fs.rmSync(ROOT, { recursive: true, force: true });
if (failed.length) {
  console.log("FAILED:", failed.map((r) => r.name).join(" | "));
  process.exit(1);
}
