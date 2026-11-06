/**
 * 技能商店 (D126) 的桥侧：地址解析、仓库树 → 技能目录、说明取自 SKILL.md、安装（全局 / 项目）、
 * 重装与防覆盖、已安装清单、以及只有用户技能目录才允许卸载（junction 只断链）。
 *
 * 全程离线：skills.sh、jsDelivr 和 raw.githubusercontent 都由一个假的 `SkillNet` 顶替，
 * 只落本机的 fixture 目录（PI_AGENT_DIR + 假 HOME），不碰真实技能目录、不联网。
 *
 *   npm run build:bridge && node bridge/tests/skill-store.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "skill-store-bridge");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const HOME = path.join(ROOT, "home");
const PROJECT = path.join(ROOT, "project");

fs.rmSync(ROOT, { recursive: true, force: true });
for (const dir of [STATE, path.join(AGENT, "skills"), path.join(HOME, ".agents", "skills"), PROJECT]) fs.mkdirSync(dir, { recursive: true });

process.env.PI_WEB_STATE = STATE;
process.env.PI_AGENT_DIR = AGENT;
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const skillstore = await import("../dist/skillstore.js");
const skillsMod = await import("../dist/skills.js");

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = false;
const check = (cond, msg) => {
  if (cond) log("  ok  ", msg);
  else {
    failed = true;
    console.error("  FAIL", msg);
  }
};

// ------------------------------------------------------------------ fake network

const TREE = {
  "acme/skills": [
    ["README.md", 40],
    ["skills/pdf/SKILL.md", 120],
    ["skills/pdf/scripts/extract.py", 200],
    ["skills/pdf/references/formats.md", 5000],
    ["skills/alpha/SKILL.md", 80],
    ["skills/alpha/SKILL.md.bak", 10],
    [".github/workflows/ci.yml", 100],
  ],
  "acme/plain": [
    ["SKILL.md", 90],
    ["notes.md", 20],
  ],
};

const RAW = new Map([
  ["https://raw.githubusercontent.com/acme/skills/HEAD/skills/pdf/SKILL.md", "---\nname: pdf\ndescription: 处理 PDF：读、拆、合。\n---\n\n正文\n"],
  ["https://raw.githubusercontent.com/acme/skills/HEAD/skills/pdf/scripts/extract.py", "print('hi')\n"],
  ["https://raw.githubusercontent.com/acme/skills/HEAD/skills/pdf/references/formats.md", "# formats\n"],
  ["https://raw.githubusercontent.com/acme/skills/HEAD/skills/alpha/SKILL.md", "---\nname: alpha\ndescription: 第一个。\n---\n"],
  ["https://raw.githubusercontent.com/acme/skills/HEAD/skills/alpha/SKILL.md.bak", "junk"],
  ["https://raw.githubusercontent.com/acme/plain/HEAD/SKILL.md", "---\nname: plain\ndescription: 根目录的技能。\n---\n"],
  ["https://raw.githubusercontent.com/acme/plain/HEAD/notes.md", "notes"],
]);

const calls = { search: 0, tree: [], file: [], fileOpts: [] };
const net = {
  json: async (url) => {
    if (url.startsWith("https://skills.sh/api/search")) {
      calls.search++;
      return {
        skills: [
          { id: "acme/skills/pdf", source: "acme/skills", skillId: "pdf", name: "pdf", installs: 12345 },
          { id: "acme/skills/alpha", source: "acme/skills", skillId: "alpha", name: "alpha", installs: 7 },
          { id: "gone/repo/x", source: "gone/repo", skillId: "x", name: "x", installs: 3 },
        ],
      };
    }
    const m = /^https:\/\/data\.jsdelivr\.com\/v1\/packages\/gh\/(.+)@HEAD\?structure=flat$/.exec(url);
    if (m) {
      calls.tree.push(m[1]);
      const tree = TREE[m[1]];
      if (!tree) throw new Error(`404 ${m[1]}`);
      return { files: tree.map(([name, size]) => ({ name: `/${name}`, size })) };
    }
    throw new Error(`意外的请求：${url}`);
  },
  file: async (url, opts) => {
    calls.file.push(url);
    calls.fileOpts.push(opts);
    const hit = RAW.get(url);
    if (hit === undefined) throw new Error(`404 ${url}`);
    return Buffer.from(hit, "utf8");
  },
};

const skillsDir = path.join(AGENT, "skills");
const agentsDir = path.join(HOME, ".agents", "skills");

// ------------------------------------------------------------------ A. 地址解析
log("A. parseSource");
{
  const cases = [
    ["anthropics/skills", { kind: "repo", repo: "anthropics/skills", ref: "HEAD", path: null }],
    ["https://github.com/anthropics/skills", { kind: "repo", repo: "anthropics/skills", ref: "HEAD", path: null }],
    ["https://github.com/anthropics/skills/tree/main/skills/pdf", { kind: "repo", repo: "anthropics/skills", ref: "main", path: "skills/pdf" }],
    ["git@github.com:anthropics/skills.git", { kind: "repo", repo: "anthropics/skills", ref: "HEAD", path: null }],
  ];
  for (const [input, want] of cases) {
    const got = skillstore.parseSource(input);
    check(JSON.stringify(got) === JSON.stringify(want), `${input} → ${JSON.stringify(got)}`);
  }
  const abs = skillstore.parseSource(PROJECT);
  check(abs.kind === "local" && abs.path === PROJECT, `本机目录 → ${JSON.stringify(abs)}`);
  check(skillstore.parseSource("").kind === "invalid", "空输入被拒");
  check(skillstore.parseSource("not a repo is plain text").kind === "invalid", "乱写的地址被拒");
}

// ------------------------------------------------------------------ B. 树 → 技能目录
log("B. skillDirs / pickSkillDir");
{
  const files = TREE["acme/skills"];
  const dirs = skillstore.skillDirs(files);
  check(JSON.stringify(dirs) === JSON.stringify(["skills/alpha", "skills/pdf"]), `两个技能目录：${JSON.stringify(dirs)}`);
  check(skillstore.pickSkillDir(dirs, "pdf") === "skills/pdf", "按名字找到 skills/pdf");
  check(skillstore.pickSkillDir(dirs, "alpha") === "skills/alpha", "按名字找到 skills/alpha");
  check(skillstore.pickSkillDir(dirs, "nope") === null, "找不到就是 null");
  const rootFiles = TREE["acme/plain"];
  check(JSON.stringify(skillstore.skillDirs(rootFiles)) === JSON.stringify([""]), "根目录 SKILL.md 记作空目录");
}

// ------------------------------------------------------------------ C. 搜索
log("C. searchSkillStore");
{
  let threw = "";
  try {
    await skillstore.searchSkillStore("p", 5, net);
  } catch (err) {
    threw = err.message;
  }
  check(threw.includes("2 个字符"), `一个字被拒：${threw}`);
  const treeBefore = calls.tree.length;
  const ranked = await skillstore.searchSkillStore("pdf", 10, net);
  check(ranked.items.length === 3, `三条结果，实际 ${ranked.items.length}`);
  check(ranked.items[0].name === "pdf" && ranked.items[0].installs === 12345, "名字与安装量照搬 skills.sh");
  check(calls.search === 1, "只有一个搜索请求");
  check(calls.tree.length === treeBefore, "第一段不碰任何仓库（先把排名画出来）");

  const res = await skillstore.describeStoreSkills(ranked.items, net);
  const pdf = res.items[0];
  check(pdf.dir === "skills/pdf", `第二段解析出目录：${pdf.dir}`);
  check(pdf.description === "处理 PDF：读、拆、合。", `说明读自 SKILL.md：${pdf.description}`);
  const gone = res.items[2];
  check(gone.dir === null && !gone.description, "仓库打不开时不给目录，也不编说明");
  check(Boolean(gone.note), "打不开的原因写在 note 里");
  check(res.note && res.note.includes("说明没查到"), "整份结果给出降级提示");
}

// ------------------------------------------------------------------ D. 仓库树缓存
log("D. jsDelivr 树缓存");
{
  const before = calls.tree.length;
  await skillstore.repoFiles("acme/skills", net);
  await skillstore.repoFiles("acme/skills", net);
  check(calls.tree.length === before, "第二次读的是磁盘缓存，没有再问 jsDelivr");
  const fresh = JSON.parse(fs.readFileSync(path.join(STATE, "market", "skill-repos.json"), "utf8"));
  check(Boolean(fresh["repo:acme/skills"]?.at), "缓存落在 state/market/skill-repos.json");
}

// ------------------------------------------------------------------ E. 按地址列出
log("E. previewSource");
{
  const repo = await skillstore.previewSource("acme/skills", net);
  check(repo.kind === "repo" && repo.items.length === 2, `仓库里列出 ${repo.items.length} 个技能`);
  const pdfItem = repo.items.find((i) => i.name === "pdf");
  check(Boolean(pdfItem) && pdfItem.description.includes("PDF"), `带说明：${JSON.stringify(repo.items.map((i) => i.name))}`);
  check(JSON.stringify(repo.items.map((i) => i.name)) === JSON.stringify(["alpha", "pdf"]), "按目录深度 + 名字排序");
  const deep = await skillstore.previewSource("https://github.com/acme/skills/tree/main/skills/alpha", net);
  check(deep.items.length === 1 && deep.items[0].name === "alpha", "URL 带路径时只列那个目录");

  const src = path.join(ROOT, "src-skills");
  fs.mkdirSync(path.join(src, "one"), { recursive: true });
  fs.mkdirSync(path.join(src, "nested", "two"), { recursive: true });
  fs.mkdirSync(path.join(src, "node_modules", "junk"), { recursive: true });
  fs.writeFileSync(path.join(src, "one", "SKILL.md"), "---\nname: one\ndescription: 一号\n---\n");
  fs.writeFileSync(path.join(src, "nested", "two", "SKILL.md"), "---\nname: two\ndescription: 二号\n---\n");
  fs.writeFileSync(path.join(src, "node_modules", "junk", "SKILL.md"), "---\nname: junk\n---\n");
  const local = await skillstore.previewSource(src, net);
  const names = local.items.map((i) => i.name);
  check(local.kind === "local" && names.includes("one") && names.includes("two"), `本机目录递归找到：${JSON.stringify(names)}`);
  check(!names.includes("junk"), "跳过 node_modules");
  check(JSON.stringify(skillstore.localSkills(path.join(src, "one")).map((i) => i.name)) === JSON.stringify(["one"]), "本身是技能就不再往下钻");
}

// ------------------------------------------------------------------ F. 从仓库安装
log("F. installSkill（仓库 → 全局）");
{
  const out = await skillstore.installSkill({ source: "acme/skills", dir: "skills/pdf", scope: "user" }, net);
  const target = path.join(skillsDir, "pdf");
  check(out.dir === target && out.files === 3, `装到 ${out.dir}，写了 ${out.files} 个文件`);
  check(fs.existsSync(path.join(target, "SKILL.md")), "SKILL.md 到位");
  check(fs.readFileSync(path.join(target, "scripts", "extract.py"), "utf8") === "print('hi')\n", "子目录里的脚本也到位");
  check(fs.existsSync(path.join(target, "references", "formats.md")), "references 到位");
  check(!fs.existsSync(path.join(skillsDir, "README.md")), "没有把仓库根的文件带出来");
  const marker = JSON.parse(fs.readFileSync(path.join(target, ".pi-store.json"), "utf8"));
  check(marker.source === "acme/skills" && marker.dir === "skills/pdf", `来源记在 .pi-store.json：${JSON.stringify(marker)}`);

  const byId = await skillstore.installSkill({ source: "acme/skills", skillId: "alpha", scope: "user" }, net);
  check(byId.name === "alpha" && fs.existsSync(path.join(skillsDir, "alpha", "SKILL.md")), "只给 skillId 也能装");
  // The whole skill folder is copied, so a stray file inside it travels with it (only the folder
  // boundary matters, not the `SKILL.md` name).
  check(fs.existsSync(path.join(skillsDir, "alpha", "SKILL.md.bak")), "目录里的其它文件跟着一起装");

  const rootSkill = await skillstore.installSkill({ source: "acme/plain", dir: "", scope: "user" }, net);
  check(rootSkill.name === "plain" && fs.existsSync(path.join(skillsDir, "plain", "notes.md")), "仓库根目录的 SKILL.md 也能装");

  const offered = calls.fileOpts.find((o) => o && o.label === "skills/pdf/SKILL.md");
  check(Boolean(offered) && offered.alt.length === 3 && offered.alt[0].includes("/gh/acme/skills@HEAD/"), `安装把三个备用源一起交给网络层（${offered ? offered.alt.length : 0} 个）`);
}

// ------------------------------------------------------------------ G. 防覆盖 / 重装
log("G. 同名保护与重装");
{
  const hand = path.join(skillsDir, "handmade");
  fs.mkdirSync(hand, { recursive: true });
  fs.writeFileSync(path.join(hand, "SKILL.md"), "---\nname: handmade\ndescription: 自己放的\n---\n");
  let threw = "";
  try {
    await skillstore.installSkill({ source: "acme/skills", dir: "skills/pdf", name: "handmade", scope: "user" }, net);
  } catch (err) {
    threw = err.message;
  }
  check(threw.includes("已经有同名技能"), `同名的手工技能不被覆盖：${threw}`);
  check(fs.readFileSync(path.join(hand, "SKILL.md"), "utf8").includes("自己放的"), "手工那份没有被删");

  fs.writeFileSync(path.join(skillsDir, "pdf", "references", "formats.md"), "被用户改过\n");
  const again = await skillstore.installSkill({ source: "acme/skills", dir: "skills/pdf", scope: "user" }, net);
  check(again.name === "pdf", "同一来源可以重装");
  check(fs.readFileSync(path.join(skillsDir, "pdf", "references", "formats.md"), "utf8") === "# formats\n", "重装清掉了改动的旧文件");

  let bad = "";
  try {
    await skillstore.installSkill({ source: "acme/skills", dir: "skills/pdf", name: "../escape", scope: "user" }, net);
  } catch (err) {
    bad = err.message;
  }
  check(bad.includes("不合法"), `名字里带路径被拒：${bad}`);
}

// ------------------------------------------------------------------ H. 装到项目
log("H. 项目范围");
{
  const out = await skillstore.installSkill({ source: "acme/skills", dir: "skills/alpha", scope: "project", cwd: PROJECT }, net);
  check(out.dir === path.join(PROJECT, ".pi", "skills", "alpha"), `装进项目的 .pi/skills：${out.dir}`);
  let threw = "";
  try {
    await skillstore.installSkill({ source: "acme/skills", dir: "skills/alpha", scope: "project", cwd: "" }, net);
  } catch (err) {
    threw = err.message;
  }
  check(threw.includes("需要先打开一个会话"), `没 cwd 不装：${threw}`);
}

// ------------------------------------------------------------------ I. 本机目录安装
log("I. installSkill（本机目录）");
{
  const src = path.join(ROOT, "src-skills", "one");
  const out = await skillstore.installSkill({ local: src, scope: "user" }, net);
  check(out.dir === path.join(skillsDir, "one") && fs.existsSync(path.join(skillsDir, "one", "SKILL.md")), "本机技能拷进用户目录");
  const marker = JSON.parse(fs.readFileSync(path.join(skillsDir, "one", ".pi-store.json"), "utf8"));
  check(marker.local === src, "记下本机来源");
}

// ------------------------------------------------------------------ J. 已安装清单
log("J. installedSkills");
{
  const list = skillstore.installedSkills(PROJECT);
  const byName = Object.fromEntries(list.map((s) => [s.name, s]));
  check(Boolean(byName.pdf) && byName.pdf.removable === true && byName.pdf.root === skillsDir, "用户技能可卸载，root 是用户目录");
  check(byName.pdf.from === "acme/skills", `清单带来源：${byName.pdf.from}`);
  check(Boolean(byName.alpha) && byName.alpha.from === "acme/skills", "项目与用户同名时先发现的项目技能胜出（alpha 已在项目里）");
  check(String(byName.alpha.root).startsWith(PROJECT), `alpha 来自项目：${byName.alpha.root}`);
  check(skillstore.installedSkills(null).every((s) => s.source !== "project"), "没有 cwd 时只列用户技能");
  const posix = list.find((s) => s.name === "pdf");
  check(typeof posix.path === "string" && fs.existsSync(posix.path), "清单里带绝对路径");
}

// ------------------------------------------------------------------ K. 卸载
log("K. removeSkill");
{
  const projectPath = path.join(PROJECT, ".pi", "skills", "alpha");
  let threw = "";
  try {
    skillstore.removeSkill(projectPath);
  } catch (err) {
    threw = err.message;
  }
  check(threw.includes("只能删用户技能目录"), `项目技能被拒：${threw}`);
  check(fs.existsSync(path.join(projectPath, "SKILL.md")), "项目技能还在");

  let rootThrew = "";
  try {
    skillstore.removeSkill(skillsDir);
  } catch (err) {
    rootThrew = err.message;
  }
  check(rootThrew.includes("只能删用户技能目录"), `技能根目录本身不能删：${rootThrew}`);

  const junk = path.join(skillsDir, "not-a-skill");
  fs.mkdirSync(junk, { recursive: true });
  fs.writeFileSync(path.join(junk, "readme.txt"), "x");
  let junkThrew = "";
  try {
    skillstore.removeSkill(junk);
  } catch (err) {
    junkThrew = err.message;
  }
  check(junkThrew.includes("没有 SKILL.md"), `没有 SKILL.md 的目录不删：${junkThrew}`);

  const removed = skillstore.removeSkill(path.join(skillsDir, "one"));
  check(removed.name === "one" && !fs.existsSync(path.join(skillsDir, "one")), "用户技能整块删掉");

  // junction / symlink：只断链，目标不动
  const real = path.join(ROOT, "elsewhere", "linked");
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, "SKILL.md"), "---\nname: linked\ndescription: 链过去的\n---\n");
  const link = path.join(agentsDir, "linked");
  const made = process.platform === "win32" ? spawnSync("cmd", ["/c", "mklink", "/J", link, real], { encoding: "utf8" }) : spawnSync("ln", ["-s", real, link], { encoding: "utf8" });
  const linked = fs.existsSync(path.join(link, "SKILL.md"));
  check(linked, `链接装好（${made.status === 0 ? "ok" : made.stderr || "已存在"}）`);
  if (linked) {
    const listed = skillstore.installedSkills(null).find((s) => s.name === "linked");
    check(Boolean(listed) && listed.link === true, "清单标出这是一个链接");
    const gone = skillstore.removeSkill(link);
    check(gone.link === true && !fs.existsSync(link), "卸载只删链接");
    check(fs.existsSync(path.join(real, "SKILL.md")), "链接指向的目录还在");
  }
}

// ------------------------------------------------------------------ L. 与面板的技能扫描一致
log("L. scanSkillEntries / scanSkills");
{
  const entries = skillsMod.scanSkillEntries(PROJECT);
  const names = entries.map((e) => e.name);
  check(names.includes("pdf") && names.includes("plain"), `用户技能也在 pi 的扫描里：${JSON.stringify(names.slice(0, 6))}`);
  const pdf = entries.find((e) => e.name === "pdf");
  check(pdf.removable === true && fs.existsSync(path.join(pdf.path, "SKILL.md")), "扫描结果带可删标记和路径");
  check(skillsMod.userSkillRootOf(pdf.path) === skillsDir, "userSkillRootOf 认出用户根");
  check(skillsMod.userSkillRootOf(path.join(PROJECT, ".pi", "skills", "alpha")) === null, "项目目录不是用户根");
  const plain = skillsMod.scanSkills(PROJECT);
  check(Array.isArray(plain) && plain.every((s) => !("path" in s)), "scanSkills 仍是面板要的那几个字段");
}

// ------------------------------------------------------------------ M. 下载的备用源（D157）
log("M. fileFetcher / mirrorUrls");
{
  const raw = "https://raw.githubusercontent.com/acme/skills/HEAD/skills/pdf/SKILL.md";
  const alts = skillstore.mirrorUrls("acme/skills", "skills/pdf/SKILL.md");
  check(alts.length === 3 && alts.every((u) => u.includes("/gh/acme/skills@HEAD/skills/pdf/SKILL.md")), `三个 jsDelivr 备用地址：${alts.length}`);
  check(skillstore.mirrorUrls("acme/skills", "notes.md", "feat/x").length === 0, "带斜杠的分支不给备用地址（jsDelivr 表达不了）");

  const opts = { alt: alts, label: "skills/pdf/SKILL.md" };
  const tried = [];
  let now = 1_000_000;
  const flaky = skillstore.fileFetcher(async (url) => {
    tried.push(url);
    if (url.startsWith("https://raw.githubusercontent.com/")) throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    return Buffer.from("body");
  }, () => now);
  const first = await flaky(raw, opts);
  check(first.toString() === "body" && tried[1] === alts[0], `raw 被重置时走备用源（${tried[1]}）`);
  tried.length = 0;
  await flaky(raw, opts);
  await flaky(raw, opts);
  check(tried.length === 2 && tried.every((u) => !u.startsWith("https://raw.githubusercontent.com/")), `十分钟内不再探死掉的主机（两个文件共 ${tried.length} 次请求）`);
  now += 11 * 60_000;
  tried.length = 0;
  await flaky(raw, opts);
  check(tried.includes(raw), "十分钟后又给 raw 一次机会");

  const notFound = [];
  const gone = skillstore.fileFetcher(async (url) => {
    notFound.push(url);
    throw Object.assign(new Error("raw.githubusercontent.com 返回 404"), { code: "HTTP_404" });
  });
  let threw = "";
  try { await gone(raw, opts); } catch (err) { threw = err.message; }
  check(threw.startsWith("下载 skills/pdf/SKILL.md 失败") && threw.includes("404"), `404 直接报，不试备用源：${threw}`);
  check(notFound.length === 1, "404 只发一个请求");

  const dead = skillstore.fileFetcher(async () => { throw new Error("socket hang up"); });
  threw = "";
  try { await dead(raw, opts); } catch (err) { threw = err.message; }
  check(threw.startsWith("下载 skills/pdf/SKILL.md 失败") && threw.includes("raw.githubusercontent.com"), `所有源都挂时报出文件和主机：${threw}`);
  check(threw.includes("HTTPS_PROXY") && threw.includes("httpProxy"), "报错末尾告诉用户能配代理");
}

// ------------------------------------------------------------------ N. 陈旧的树（D157）
log("N. 树比仓库旧时自愈");
{
  const stale = [["skills/xlsx/SKILL.md", 40], ["skills/xlsx/scripts/office/pack.py", 20]];
  const live = [["skills/xlsx/SKILL.md", 40], ["skills/xlsx/scripts/office/unpack.py", 30]];
  const seen = { github: 0, files: [] };
  const drift = {
    json: async (url) => {
      if (url.startsWith("https://data.jsdelivr.com/")) return { files: stale.map(([name, size]) => ({ name: `/${name}`, size })) };
      if (url.startsWith("https://api.github.com/repos/acme/xlsx/git/trees/HEAD")) {
        seen.github++;
        return { tree: live.map(([p, size]) => ({ path: p, size, type: "blob" })) };
      }
      throw new Error(`意外的请求：${url}`);
    },
    file: async (url, opts) => {
      seen.files.push(opts?.label ?? url);
      if (String(opts?.label) === "skills/xlsx/scripts/office/pack.py") throw Object.assign(new Error("raw.githubusercontent.com 返回 404"), { code: "HTTP_404" });
      return Buffer.from("x", "utf8");
    },
  };
  const out = await skillstore.installSkill({ source: "acme/xlsx", skillId: "xlsx", scope: "user" }, drift);
  check(seen.github === 1, `某个文件 404 后向 GitHub 要了一次新树（${seen.github} 次）`);
  check(fs.existsSync(path.join(out.dir, "scripts", "office", "unpack.py")) && !fs.existsSync(path.join(out.dir, "scripts", "office", "pack.py")), "按新树装完，旧树里的 pack.py 没留");
  check(out.files === 2, `文件数按新树算：${out.files}`);
  const before = seen.github;
  await skillstore.installSkill({ source: "acme/xlsx", skillId: "xlsx", scope: "user" }, drift);
  check(seen.github === before, "新树进了缓存，第二次安装不再问 GitHub");
}

console.log(failed ? "\nFAILED" : "\nALL OK");
process.exit(failed ? 1 : 0);
