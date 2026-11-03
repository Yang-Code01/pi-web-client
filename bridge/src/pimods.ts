/**
 * Modules from the installed pi package, loaded into the bridge process.
 *
 * Some things are only done right by pi's own code: writing a forked session file, merging a
 * settings.json under pi's lockfile, reading and writing trust.json. Re-implementing those would
 * drift from pi; spawning pi for them can touch files we must not touch (D77). The package is found
 * from the resolved `cli.js` (`<pkg>/dist/bundle/cli.js`); the modules are internal paths, not in
 * pi's `exports`, so a missing one is reported as such instead of crashing the bridge.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const cache = new Map<string, Promise<any>>();

export function piPackageDir(cli: string): string {
  // Test seam: tests run a scripted pi (PI_BIN) but still need pi's real modules.
  if (process.env.PI_WEB_PI_PKG) return process.env.PI_WEB_PI_PKG;
  return path.dirname(path.dirname(path.dirname(cli)));
}

export function piModule<T = any>(cli: string, rel: string): Promise<T> {
  const file = path.join(piPackageDir(cli), "dist", ...rel.split("/"));
  let hit = cache.get(file);
  if (!hit) {
    hit = import(pathToFileURL(file).href).catch((err) => {
      cache.delete(file);
      throw new Error(`加载不了 pi 的模块（${file}）：${(err as Error).message}`);
    });
    cache.set(file, hit);
  }
  return hit as Promise<T>;
}
