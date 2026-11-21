// 原型构建：把 src.html 里的两个占位换掉，产出可以直接打开的单文件 model-dialog.html。
//   1) 主题 token 直接取 web/src/theme-tokens.css（颜色和真界面一致，不手抄）
//   2) 模型目录取本机 ~/.pi/agent/models.json，只留 id / 名字 / 来源 / 上下文，密钥不进来
// 跑：node .scratch/proto-model-dialog/build.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

const tokens = fs.readFileSync(path.join(repo, "web/src/theme-tokens.css"), "utf8");
const store = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi/agent/models.json"), "utf8"));

const catalog = [];
for (const [provider, p] of Object.entries(store.providers || {})) {
  for (const m of p.models || []) {
    catalog.push({
      key: `${provider}/${m.id}`,
      id: m.id,
      name: m.name || m.id,
      provider,
      ctx: m.contextWindow || 0,
      vision: (m.input || []).includes("image"),
    });
  }
}

const src = fs.readFileSync(path.join(here, "src.html"), "utf8");
const out = src
  .replace("/*__TOKENS__*/", () => tokens)
  .replace("/*__CATALOG__*/ []", () => JSON.stringify(catalog));

const file = path.join(here, "model-dialog.html");
fs.writeFileSync(file, out);
console.log(`${path.relative(repo, file)}  ${(out.length / 1024).toFixed(1)} KB  · ${catalog.length} 个模型 / ${new Set(catalog.map((m) => m.provider)).size} 个来源`);
