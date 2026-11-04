/**
 * One writer per shared resource (D113). The 扩展 manager's write operations touch things that do not
 * tolerate a second writer, each in a different way:
 *
 * - `~/.pi/agent/npm` is one npm project: `pi install` / `remove` / `update` all run
 *   `npm install … --prefix <that dir>`, so two at once fight over node_modules and package-lock.
 * - `pi install` / `remove` also rewrite the *whole* package list in settings.json from a snapshot
 *   they read before installing, so a concurrent write loses the other one's change.
 * - `ext.toggle` computes the new `extensions` list from a read it did itself (the write itself is
 *   under pi's lock, the read is not), so two toggles in the same settings.json lose one.
 * - `mcp.toggle` / `mcp.bump` rewrite a whole mcp.json the same way.
 *
 * So operations take a lock *named after the resource they touch*: everything under `npm` (packages,
 * `pi mcp add/remove/login/logout`) is one key, each settings scope is one, each mcp.json is one.
 * Different resources still run in parallel — that is what makes 「同时点几个按钮」 work without
 * the corruption the page's old 「一条命令跑完前全部置灰」 was avoiding.
 */

/** Queue `fn` behind everything already queued under `key`; resolves with `fn`'s own result. */
export type WriteLock = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

export function createWriteLock(): WriteLock {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve();
    // A failed predecessor must not stop the queue: run either way.
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    tails.set(key, tail);
    // Drop the key once the queue drains, so a long-lived bridge does not keep one entry per file.
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return next;
  };
}
