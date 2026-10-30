import { spawn } from "node:child_process";
const CLI = "C:/Users/GG_Bond/AppData/Local/nvm/v23.11.1/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const child = spawn(process.execPath, [CLI, "--mode", "rpc"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, "");
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type === "response" && m.command === "get_available_models") {
      const models = m.data?.models ?? [];
      console.log("count:", models.length);
      console.log(JSON.stringify(models[0], null, 1).slice(0, 1200));
      const keys = new Set(models.flatMap((x) => Object.keys(x)));
      console.log("keys:", [...keys].join(","));
      const provs = [...new Set(models.map((x) => x.provider))];
      console.log("providers:", provs.join(", "));
      console.log("sample names:", models.slice(0, 6).map((x) => `${x.provider}/${x.id} = ${x.name ?? ""} think=${JSON.stringify(x.thinkingLevels ?? x.thinkingLevelMap ?? null)}`).join(" | "));
      child.stdin.end();
      setTimeout(() => process.exit(0), 300);
    }
  }
});
child.stdin.write(JSON.stringify({ id: "m1", type: "get_available_models" }) + "\n");
setTimeout(() => { console.error("timeout"); process.exit(1); }, 30000);
