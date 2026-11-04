/**
 * The pi CLI the bridge itself would spawn (D114). Probes used to hardcode one machine's nvm path
 * (`C:/Users/GG_Bond/AppData/Local/nvm/v23.11.1/node_modules/…/cli.js`); `bridge/src/pi.ts` already
 * answers this portably (PI_BIN → launchers on PATH → nvm → npm root), so reuse it.
 *
 * Needs a built bridge (`npm run build:bridge`), which these probes ask for anyway.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "./paths.mjs";

export async function piCli() {
  const mod = await import(pathToFileURL(path.join(REPO, "bridge", "dist", "pi.js")).href);
  return mod.resolvePi().cli;
}
