// Stand-in for the GitHub CLI in tests (PI_WEB_GH_JS): `gh auth status` and `gh gist create`.
import fs from "node:fs";
const args = process.argv.slice(2);
const flag = process.env.FAKE_GH_STATE || "";
if (args[0] === "auth" && args[1] === "status") {
  const loggedOut = flag && fs.existsSync(flag) && fs.readFileSync(flag, "utf8").includes("logged-out");
  if (loggedOut) {
    process.stderr.write("You are not logged into any GitHub hosts.\n");
    process.exit(1);
  }
  process.stdout.write("Logged in to github.com\n");
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
