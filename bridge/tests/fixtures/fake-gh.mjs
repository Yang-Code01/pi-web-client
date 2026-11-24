// Stand-in for the GitHub CLI in tests (PI_WEB_GH_JS): `gh auth status` / `gh auth token` / `gh gist create`.
import fs from "node:fs";
const args = process.argv.slice(2);
const flag = process.env.FAKE_GH_STATE || "";
/** `[{login, active}]`：给了就按真 gh 的多账号文本输出（GitHub 通道的用例靠它）。 */
const accounts = (() => {
  try {
    const raw = JSON.parse(process.env.FAKE_GH_ACCOUNTS || "[]");
    return Array.isArray(raw) ? raw.filter((a) => a && a.login) : [];
  } catch {
    return [];
  }
})();
if (args[0] === "auth" && args[1] === "status") {
  const loggedOut = flag && fs.existsSync(flag) && fs.readFileSync(flag, "utf8").includes("logged-out");
  if (loggedOut) {
    process.stderr.write("You are not logged into any GitHub hosts.\n");
    process.exit(1);
  }
  if (accounts.length > 0) {
    // 真 gh 2.x 的形状（`bridge/src/github.ts` 的解析器就是照它写的）。
    const lines = ["github.com"];
    for (const a of accounts) {
      lines.push(`  \u2713 Logged in to github.com account ${a.login} (keyring)`);
      lines.push(`  - Active account: ${a.active ? "true" : "false"}`);
      lines.push("  - Git operations protocol: https");
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exit(0);
  }
  process.stdout.write("Logged in to github.com\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "token") {
  const at = args.indexOf("--user");
  const login = at >= 0 ? args[at + 1] : accounts.find((a) => a.active)?.login;
  if (!login || (accounts.length > 0 && !accounts.some((a) => a.login === login))) {
    process.stderr.write(`no oauth token for ${String(login)}\n`);
    process.exit(1);
  }
  process.stdout.write(`gho_fake_${login}\n`);
  process.exit(0);
}
if (args[0] === "gist" && args[1] === "create") {
  const file = args[args.length - 1];
  if (!args.includes("--public=false") || !fs.existsSync(file)) {
    process.stderr.write("bad gist args\n");
    process.exit(2);
  }
  if (flag) fs.writeFileSync(flag, JSON.stringify({ uploaded: fs.readFileSync(file, "utf8").slice(0, 2000), args }));
  process.stdout.write("https://gist.github.com/someone/0123abcd\n");
  process.exit(0);
}
process.stderr.write(`fake gh: unsupported ${args.join(" ")}\n`);
process.exit(3);
