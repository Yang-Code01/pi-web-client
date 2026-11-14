/**
 * 用例集：预览翻译「改译文 → 同步原文」写回链路（PR #418 / D245 修订）。
 *
 *   PI_BIN=<桩 pi> bash .pi/skills/pi-web-test-html/bin/env.sh fresh <仓库> wk translate-sync
 *   node .pi/skills/pi-web-test-html/bin/run-book.mjs --case translate-sync --cwd <夹具目录> --video
 *
 * 盯的是用户报的那条症状：把某节标题的译文改成中文语义后点「同步原文」，桥的语言护栏
 * 误判「写回的是日文，原文不是」，整块拒绝写回。桩 pi 的行为是固定的（见 fixture 注释），
 * 所以这条用例在任何机器上结论一致：
 *   - 正向：逐行去假名加「译 」，并且**吞掉 `---` 分隔线**（真模型也这么干）；
 *   - 反向：改动块写回「原文 + についてのご案内」——假名够多、和原文不同。
 */
import fs from "node:fs";
import path from "node:path";

const NAME = "納期遅延の報.md";

const SRC = [
  "# 納期遅延の報・連・相",
  "",
  "場面：部長に納期の遅れを報告し、その後で客先に電話する。",
  "",
  "---",
  "",
  "## 本文の中国語訳",
  "",
  "田中は部長に、来月末の納品が一週間ほど遅れると伝えた。",
  "",
].join("\n");

/** 改后的标题译文：中文语义，逼模型给一个和原文不同的日文标题。 */
const EDIT_TO = "## 附录：本文的中文译文";

/** 旧代码在这块上会退的话（用户截图里那句），新代码不该再出现。 */
const BUG_TEXTS = ["写回的是日文，原文不是", "这一块没有写回", "整节重译", "写回的是中文"];

export const meta = {
  title: "pi-web-client · 预览翻译「同步回原文」测试书",
  module: "预览 / 翻译对照",
  branch: "fix/translate-reverse-guard",
  pr: "#418",
  decision: "D245",
  output: "翻译同步回原文-测试书",
  extraEnv: {
    翻译模型: "桩（fake pi：正向去假名、反向写回日文）",
    夹具: NAME,
    dataDir: "隔离实例的状态目录 pi-web-test-dev/<id>/bridge/translate（译文缓存），跑完清空；不碰正式 7864",
  },
  spec: {
    conclusion:
      "结论：修复后 6/6 通过——「同步原文」不再误判「写回的是日文，原文不是」，" +
      "`---` 分隔线被模型吞掉也不再触发整节重译；同一本书在修复前的代码上跑出 3/6，" +
      "TC-04 的失败证据正是用户截图里那句。",
    rerun: [
      `1. 夹具：把 6 节日文 md 放到任意目录（用例会写入 ${NAME}），启动环境时把 --cwd 指过去`,
      "2. 起隔离环境： PI_BIN=<桩> bash .pi/skills/pi-web-test-html/bin/env.sh fresh <仓库> wk translate-sync",
      "3. 跑书： node .pi/skills/pi-web-test-html/bin/run-book.mjs --case translate-sync --base <页面> --cwd <夹具目录> --video",
      "4. 出产物： python .pi/skills/pi-web-test-html/bin/build-xlsx.py --dir <out> && node .pi/skills/pi-web-test-html/bin/build-html.mjs --dir <out>",
      "5. 收工： bash .pi/skills/pi-web-test-html/bin/env.sh down <仓库> wk",
    ],
    envNote:
      "说明：翻译模型用的是桩 pi（bridge/tests/fixtures/fake-pi-translate.mjs 的兄弟件），" +
      "不花模型 turn、不依赖网关；真模型（wb2api/cn:deepseek-v4.1-flash）另在 PR #418 里单独验过。" +
      "页面状态全部来自隔离实例的 state 目录，不碰正式 7864。",
  },
  order: ["TC-01", "TC-02", "TC-03", "TC-04", "TC-05", "TC-06"],
};

export default async function translateSync(h) {
  const { page, openCase, step, ok, fail, shot, pause, log } = h;

  const cwd = h.session?.cwd ?? (await h.openSession(path.resolve(".scratch/testbook/translate-sync/work"), "translate-sync")).cwd;
  const doc = path.join(cwd, NAME);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(doc, SRC, "utf8");
  log(`夹具 ${doc}`);

  const leftText = () => page.locator(".tr-cmp .tr-row .tr-src").first().innerText().catch(() => "");
  const kana = (s) => (String(s).match(/[\u3040-\u30ff]/g) ?? []).length;

  // ---- TC-01 打开文件、进对照页
  openCase({
    id: "TC-01",
    title: "预览里打开日文 md 并进入翻译对照",
    precondition: "测试实例；会话 cwd 里放着夹具",
    check: "文件面板能点开 md，「译」按钮可用",
    fix: "—",
  });
  let s = step("点顶部「文件」，在浏览态点开夹具 md", "预览面板标题是文件名，正文是日文原文");
  await page.locator(".topbar .icon-btn", { hasText: "文件" }).click();
  await page.locator(".viewer-browse .dirpicker").waitFor({ timeout: 15_000 });
  await page.locator(".dir-row.file-row", { hasText: NAME }).first().click();
  await page.locator(".viewer-body .md-doc").waitFor({ timeout: 15_000 });
  await page.waitForFunction((n) => document.querySelector(".viewer-name")?.textContent === n, NAME, { timeout: 15_000 });
  ok(s, "打开了 " + NAME);
  await pause(900);
  const viewerShot = await shot(s, ".viewer", "opened");

  // ---- TC-02 翻译：左日右中
  openCase({
    id: "TC-02",
    title: "选中文翻译：译文不再带假名",
    precondition: "夹具已打开",
    check: "对照两栏，左栏日文、右栏中文（假名 0）",
    fix: "—",
  });
  s = step("点「译」→ 选中文 → 开始", "自动全屏，左右两栏都出来");
  await page.locator(".viewer-tools button.viewer-btn", { hasText: "译" }).first().click();
  await pause(800);
  const pick = page.locator(".tr-pick");
  await pick.waitFor({ timeout: 10_000 });
  await pick.locator(".tr-langbtn", { hasText: "中文" }).click();
  await pause(900);
  await pick.locator(".choose-row button.primary", { hasText: "开始" }).click();
  await pause(600);
  await page.locator(".tr-cmp .tr-row").first().waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => document.querySelectorAll(".tr-cmp .tr-row").length === 2, null, { timeout: 30_000 });
  ok(s, "两栏对照已渲染");
  const left0 = await leftText();
  const right0 = await page.locator(".tr-cmp .tr-row .tr-out").first().innerText();
  if (kana(left0) > 0) ok(s, `左栏是日文原文（假名 ${kana(left0)}）`);
  else fail(s, "左栏不像日文");
  if (kana(right0) === 0) ok(s, "右栏译文里没有假名");
  else fail(s, `右栏还留着 ${kana(right0)} 个假名`);
  await pause(1200);
  await shot(s, ".viewer", "compared");

  // ---- TC-03 改一节标题的译文
  openCase({
    id: "TC-03",
    title: "改译文：只动缓存，不碰原文",
    precondition: "对照页在",
    check: "编辑态每节一个编辑框，Ctrl+S 有回执，源文件没变",
    fix: "—",
  });
  s = step("点「改译文」：改两处——第 2 节的标题译文改成「## 附录：本文的中文译文」，第 1 节的段落补一句「（补一句）」", "回执「译文已保存」，磁盘原文一字没动");
  await page.locator(".tr-tools button", { hasText: "改译文" }).click();
  await pause(900);
  const tas = page.locator("textarea.tr-sed");
  await tas.first().waitFor({ timeout: 10_000 });
  const n = await tas.count();
  ok(s, `编辑框 ${n} 个（每节一个）`);
  let hit = -1;
  for (let i = 0; i < n; i += 1) {
    if ((await tas.nth(i).inputValue()).includes("本文")) {
      hit = i;
      break;
    }
  }
  if (hit < 0) hit = n - 1;
  // 只改标题那一行：整框替掉会连同段落一起删，那属于「结构变了」，是另一条路。
  const before = await tas.nth(hit).inputValue();
  ok(s, `改前这一节开头：${before.split("\n")[0]}`);
  await tas.nth(hit).click();
  await pause(700);
  // 用键盘逐字敲标题：录屏里能看清改的是哪一行；整框 fill 是一瞬间换掉，看不出来。
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.type(EDIT_TO, { delay: 80 });
  const headNow = (await tas.nth(hit).inputValue()).split("\n")[0].trim();
  if (headNow === EDIT_TO) ok(s, `标题逐字敲成了「${EDIT_TO}」`);
  else fail(s, `标题没改对：${headNow}`);
  // 第 1 节也动一处：模型把它那个 `---` 吞了，这一节才会进块级比对（验分隔块过滤）。
  const first = 0;
  const v0 = await tas.nth(first).inputValue();
  const lines0 = v0.split("\n");
  let lastBody = -1;
  for (let i = lines0.length - 1; i >= 0; i -= 1) if (lines0[i].trim()) { lastBody = i; break; }
  lines0[lastBody] = `${lines0[lastBody]}（补一句）`;
  await tas.nth(first).click();
  await tas.nth(first).fill(lines0.join("\n"));
  await pause(700);
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() => (document.querySelector(".tr-brief")?.textContent ?? "").includes("译文已保存"), null, {
    timeout: 20_000,
  });
  ok(s, `第 ${hit + 1} 节已保存到缓存`);
  if (fs.readFileSync(doc, "utf8") === SRC) ok(s, "源文件没被改");
  else fail(s, "保存译文时碰了源文件");
  await pause(1200);
  await shot(s, ".viewer", "edited");

  // ---- TC-04 同步原文：差异预览不误判
  openCase({
    id: "TC-04",
    title: "同步原文：差异预览不再误判「写回的是日文」",
    precondition: "译文已改并保存",
    check: "出现 1 处改动，且没有语言误判/整节重译/没写回 的字样",
    fix: "D245 修订：标题块在 docJa 下只要求有假名；结构比对先滤掉 --- 分隔线",
  });
  s = step("点「同步原文」", "确认页列出改动块，且不含误判告警");
  await page.locator(".tr-tools button", { hasText: "同步原文" }).click();
  await pause(900);
  const review = page.locator(".tr-review");
  await review.waitFor({ timeout: 60_000 });
  const diffs = await review.locator(".tr-diff").count();
  if (diffs >= 1) ok(s, `${diffs} 块改动`);
  else fail(s, "确认页里没有改动块");
  const reviewText = await review.innerText();
  const offenders = BUG_TEXTS.filter((t) => reviewText.includes(t));
  if (offenders.length === 0) ok(s, "没有误判告警");
  else fail(s, `确认页里出现：${offenders.join("、")}`);
  const del = await review.locator(".tr-diff pre.del").first().innerText();
  ok(s, `原文侧：${del.split("\n")[0]}`);
  await pause(1600);
  await shot(s, ".tr-review", "review");

  // ---- TC-05 写回：左栏换回日文
  openCase({
    id: "TC-05",
    title: "写回原文：标题变回日文，左栏同步",
    precondition: "确认页在，1 处改动",
    check: "回执「已写回原文」，左栏与新原文都是日文，没有「改过」标记",
    fix: "D245 修订",
  });
  s = step("点「写回原文」", "回执「已写回原文」，左栏标题变成日文");
  // 写回前先把两栏拍一张：跟写回后那张并排看，改了哪一行一眼能对上。
  await pause(1400);
  await shot(s, ".tr-cmp", "before-apply");
  await pause(500);
  await review.locator(".choose-row button.primary", { hasText: "写回原文" }).click();
  await page.waitForFunction(() => (document.querySelector(".tr-brief")?.textContent ?? "").includes("已写回原文"), null, {
    timeout: 30_000,
  });
  ok(s, "已写回");
  await pause(2200);
  const left1 = await page.locator(".tr-cmp .tr-row").nth(hit).locator(".tr-src").innerText();
  if (kana(left1) > 0 && left1.includes("ご案内")) ok(s, `左栏标题已是日文：${left1.split("\n")[0]}`);
  else fail(s, `左栏标题不是写回的日文：${left1.slice(0, 60)}`);
  if ((await page.locator(".tr-cmp .tr-row.edited").count()) === 0) ok(s, "没有残留「改过」标记");
  else fail(s, "写回后仍标着「改过」");
  ok(s, `对照写回前那张：标题 \`本文の中国語訳\` → \`${left1.split("\n")[0]}\`，第 1 节末尾多出一句日文`);
  ok(s, "右栏还是你手改的译文——写回只改原文，不重翻；要重翻点「更新」");
  await shot(s, ".tr-cmp", "after-apply");
  await shot(s, ".viewer", "applied");

  // ---- TC-06 磁盘复核
  openCase({
    id: "TC-06",
    title: "磁盘复核：只改那一处，分隔线还在",
    precondition: "已写回",
    check: "文件里标题是日文、正文与 --- 原样",
    fix: "分隔线过滤只影响比对，不影响写回",
  });
  s = step("读磁盘上的 md", "标题行变日文；`---` 与正文原样保留");
  const after = fs.readFileSync(doc, "utf8");
  // 行级差异：光靠「包含某字符串」看不出「到底改了几处」，人容易怀疑没写回。
  const linesOf = (t) => t.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
  const oldLines = linesOf(SRC);
  const newLines = linesOf(after);
  const gone = oldLines.filter((l) => !newLines.includes(l));
  const came = newLines.filter((l) => !oldLines.includes(l));
  if (gone.length === 1 && came.length === 2) ok(s, "整篇只动一处：改 1 行标题、加 1 句日文");
  else fail(s, `改动面不对：删 ${gone.length} 行、加 ${came.length} 行`);
  ok(s, `改：${gone.map((l) => `\`${l}\``).join("、") || "—"}`);
  ok(s, `成：${came.map((l) => `\`${l}\``).join("、") || "—"}`);
  if (after.includes("についてのご案内")) ok(s, "标题写回成日文");
  else fail(s, "磁盘上的标题没变成日文");
  if (!after.includes("附录")) ok(s, "中文标题没漏到磁盘");
  else fail(s, "中文标题进了原文文件");
  if (after.includes("\n---\n")) ok(s, "`---` 分隔线还在");
  else fail(s, "`---` 被写回吞掉了");
  if (after.includes("田中は部長に、来月末の納品が一週間ほど遅れると伝えた。")) ok(s, "正文原样");
  else fail(s, "正文被动过");
  if (after.includes("この件についても中止してください。")) ok(s, "第 1 节改的那块写回了日文");
  else fail(s, "第 1 节的改动没写回");
  // 再从界面确认一遍：切回「预览」，渲染的就是磁盘上那份 md。
  await page.locator(".tr-tools button", { hasText: "返回预览" }).click().catch(() => {});
  await page.locator(".viewer-body .md-doc").waitFor({ timeout: 10_000 }).catch(() => {});
  const rendered = await page.locator(".viewer-body .md-doc").innerText().catch(() => "");
  if (rendered.includes("についてのご案内") && rendered.includes("この件についても中止してください。"))
    ok(s, "预览里渲染出来的也是新文字");
  else fail(s, "预览里还是旧文字");
  await pause(1200);
  await shot(s, ".viewer", "disk");
  h.sortCases(meta.order);
  void viewerShot;
}
