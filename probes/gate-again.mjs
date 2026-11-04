/** Does the approval gate fire with and without -ne? Prints raw RPC lines. */
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { REPO } from "../tools/paths.mjs";
import { piCli } from "../tools/pi.mjs";

const CLI = process.env.PI_CLI ?? (await piCli());
const GATE = path.join(REPO, "bridge/ext/approval-gate.ts");
const mode = process.argv[2] ?? "with-ne";
const withNe = mode === "with-ne";

const args = ["--mode", "rpc"];
if (withNe) args.push("-ne");
args.push("-e", GATE);
args.push("--session-id", crypto.randomUUID());

const child = spawn(process.execPath, [CLI, ...args], {
  cwd: REPO,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PI_WEB_ALLOW_FILE: path.join(REPO, ".scratch/allow-test.json") },
});
child.stderr.on("data", (d) => console.log("[stderr]", d.toString().trim().slice(0, 300)));

const rl = readline.createInterface({ input: child.stdout });
let asked = false;
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log("[raw]", line.slice(0, 200));
    return;
  }
  const t = msg.type ?? msg.method;
  const id = msg.id ?? msg.commandId;
  if (t === "extension_ui_request") {
    console.log("[UI REQUEST]", msg.method, JSON.stringify(msg).slice(0, 300));
    asked = true;
    setTimeout(() => {
      console.log("-> answering cancelled:false? refuse");
      child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: msg.id, confirmed: false }) + "\n");
    }, 800);
    return;
  }
  if (t === "extension_ui_response") return;
  if (t === "response") return;
  console.log("[ev]", t, JSON.stringify(msg).slice(0, 180));
});

child.on("exit", (code) => {
  console.log(`exit=${code} gateFired=${asked}`);
  process.exit(0);
});

await new Promise((r) => setTimeout(r, 2500));
console.log(`--- prompt (${mode}) ---`);
child.stdin.write(
  JSON.stringify({
    type: "prompt",
    id: "p1",
    message: process.argv[3] ?? `用 bash 工具执行：rm -rf ${REPO}/.scratch/gate-probe-nonexistent`,
  }) + "\n",
);
setTimeout(() => {
  console.log("--- timeout, killing ---");
  child.kill();
}, 90000);
