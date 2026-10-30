/**
 * Drag assertions for the session-management samples: HTML5 DnD must really move cards
 * between sections (A) and between groups (B).
 * Run: node probes/session-manage-drag.mjs
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);

const DIR = "F:/pi-web-client/.scratch/session-manage/prototype";
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok:", msg);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });

/** Playwright's mouse path does not always raise HTML5 drag events; drive them explicitly. */
async function drag(page, fromSel, toSel) {
  await page.evaluate(
    ({ fromSel, toSel }) => {
      const from = document.querySelector(fromSel);
      const to = document.querySelector(toSel);
      if (!from || !to) throw new Error(`missing node ${fromSel} or ${toSel}`);
      const dt = new DataTransfer();
      from.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      const r = to.getBoundingClientRect();
      to.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + 4 }));
      to.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + 4 }));
      from.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    },
    { fromSel, toSel },
  );
  await page.waitForTimeout(250);
}

// ---------------------------------------------------------------- A: 拖进置顶区即置顶
await page.goto(pathToFileURL(`${DIR}/a-pin-drag.html`).href);
await page.waitForTimeout(200);
const pinHead = await page.locator(".sec", { hasText: "置顶" }).first().locator(".sec-head").innerText();
assert(/^置顶\s*2/.test(pinHead.replace(/\n/g, " ")), `A starts with 2 pinned (${pinHead.replace(/\n/g, " ")})`);
await drag(page, ".card[data-id='s06']", ".cards[data-sec='pin']");
const pinHead2 = await page.locator(".sec", { hasText: "置顶" }).first().locator(".sec-head").innerText();
assert(/^置顶\s*3/.test(pinHead2.replace(/\n/g, " ")), `A pinned a dragged card (${pinHead2.replace(/\n/g, " ")})`);
const inPin = await page.locator(".cards[data-sec='pin'] .card:has-text('claim 接管探针')").count();
assert(inPin === 1, "A moved the card into the pinned section");
const toast = await page.locator(".toast").innerText();
assert(toast.includes("state/order.json"), `A saved through state/order.json (${toast})`);

// ---------------------------------------------------------------- A: 拖出置顶区即取消
await drag(page, ".cards[data-sec='pin'] .card[data-id='s06']", ".cards[data-sec='rest']");
const pinHead3 = await page.locator(".sec", { hasText: "置顶" }).first().locator(".sec-head").innerText();
assert(/^置顶\s*2/.test(pinHead3.replace(/\n/g, " ")), "A unpinned it when dragged back to 其它");

// ---------------------------------------------------------------- B: 拖进分组
await page.goto(pathToFileURL(`${DIR}/b-groups.html`).href);
await page.waitForTimeout(200);
await drag(page, ".card[data-id='s08']", ".cards[data-group='g2']");
const inGroup2 = await page.locator(".cards[data-group='g2'] .card:has-text('隧道回连稳定性')").count();
assert(inGroup2 === 1, "B moved the card into 临时 · 实验");
const g2Head = await page.locator(".cards[data-group='g2']").evaluate((el) => el.previousElementSibling.textContent);
assert(/临时 · 实验\s*2/.test(g2Head.replace(/\s+/g, " ")), `B group count follows (${g2Head})`);

// ---------------------------------------------------------------- C: 选择 + 归档 + 恢复 + 删除护栏
await page.goto(pathToFileURL(`${DIR}/c-manage-mode.html`).href);
await page.waitForTimeout(200);
await page.click("#manage");
await page.locator(".card:has-text('修 sidebar')").click();
await page.locator(".card:has-text('claim 接管探针')").click();
assert((await page.locator("#what").innerText()) === "选 2 个", "C counts the selection");
await page.click("#arch");
await page.waitForTimeout(250);
const archSection = await page.locator(".sec", { hasText: "已归档" }).locator(".card").count();
assert(archSection === 3, `C archived both (已归档 now ${archSection})`);
await page.locator(".sec", { hasText: "已归档" }).locator(".card:has-text('修 sidebar') .act").click();
await page.waitForTimeout(250);
assert((await page.locator(".sec", { hasText: "已归档" }).locator(".card").count()) === 2, "C restored one from 已归档");

await page.click("#manage"); // leave multi-select, pick the approval-pending card alone
await page.click("#manage");
await page.locator(".card:has-text('日语 N2')").click();
await page.click("#del");
const refused = await page.locator(".toast").innerText();
assert(refused.includes("不能删"), `C refuses to delete a 待确认 session (${refused})`);
assert((await page.locator(".card:has-text('日语 N2')").count()) === 1, "C kept it");

await page.locator(".card:has-text('日语 N2')").click(); // clear the refused selection
await page.locator(".sec", { hasText: "已归档" }).locator(".card:has-text('claim 接管探针')").click();
await page.click("#del");
await page.click("#del");
await page.waitForTimeout(300);
const afterFirst = await page.locator(".sec", { hasText: "已归档" }).locator(".card:has-text('claim 接管探针')").count();
assert(afterFirst === 0, "C two-step delete removed the archived card");

await browser.close();
console.log("ALL OK");
