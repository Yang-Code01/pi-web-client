/**
 * Screenshots for the session-management samples (D46 prototypes).
 * Run: node probes/session-manage-shots.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const DIR = path.join(REPO, ".scratch/session-manage/prototype");
const OUT = path.join(REPO, ".scratch/session-manage/shots");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });

async function open(file) {
  await page.goto(pathToFileURL(`${DIR}/${file}`).href);
  await page.waitForTimeout(250);
}

const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log("shot", name);
};

await open("index.html");
await shot("0-index");

await open("a-pin-drag.html");
await shot("a-default");
// pin one more card, then check the pinned section grew and the footer says where it went
await page.locator(".card:has-text('claim 接管探针') .pin").click();
await page.waitForTimeout(300);
await shot("a-pinned");

await open("b-groups.html");
await shot("b-default");

await open("c-manage-mode.html");
await shot("c-default");
await page.click("#manage");
await page.locator(".card:has-text('修 sidebar')").click();
await page.locator(".card:has-text('claim 接管探针')").click();
await page.waitForTimeout(300);
await shot("c-managing");

await browser.close();
console.log("done:", OUT);
