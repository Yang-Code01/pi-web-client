/**
 * 输入框 `/` 菜单的过滤与排序（#25）。
 *
 * 名字优先，描述兜底：只要名字有命中，就不拿描述来凑数。描述是自然语言，`hand` 会命中
 * `handle` / `handles` / `Hand the current…`，敲三个字母整个技能表都亮着，等于没过滤
 * （2026-11-06 用户报障：`/hand` 下列表照旧是六个互不相干的技能）。
 *
 * 名字这一侧还要认命名空间：pi 把技能报成 `skill:handoff`，人敲的是 `hand`，所以匹配
 * 看的是冒号后面那段（尾巴），而不是整串；尾巴内部再按 `-` `_` `.` 切词，`/hand` 能命中
 * `claude-handoff` 里的 `handoff`。用户自己敲了 `skill:` 也照样能剥掉，`/skill:hand`
 * 和 `/hand` 是一回事。
 */
export type CommandItem = { insert: string; label: string; desc?: string; tag?: string };

const WORDS = /[:._\-\s]+/;
const words = (s: string) => s.split(WORDS).filter(Boolean);

/** 名字命中的档位，越小越靠前；-1 = 没命中。 */
function nameRank(label: string, q: string): number {
  const name = (label.startsWith("/") ? label.slice(1) : label).toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  const colon = name.lastIndexOf(":");
  const ns = colon >= 0 ? name.slice(0, colon + 1) : "";
  const tail = colon >= 0 ? name.slice(colon + 1) : name;
  // 命名空间只认整段前缀，不参与子串匹配：否则 `/kill` 会命中每一个 `skill:`。
  const tq = ns && q.startsWith(ns) ? q.slice(ns.length) : q;
  if (!tq) return 2; // 只敲了 `skill:`
  if (tail.startsWith(tq)) return 2;
  if (words(tail).some((w) => w.startsWith(tq))) return 3;
  if (tail.includes(tq)) return 4;
  if (ns) return -1;
  if (words(name).some((w) => w.startsWith(q))) return 3;
  return name.includes(q) ? 4 : -1;
}

export function filterCommands(all: CommandItem[], query: string): CommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, 40);
  const named = all
    .map((item, i) => ({ item, i, rank: nameRank(item.label, q) }))
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .slice(0, 40)
    .map((x) => x.item);
  if (named.length) return named;
  // 名字一个都没中才看描述：两个字母连描述也不看，否则半个技能表都能中。
  if (q.length < 3) return [];
  return all.filter((x) => (x.desc ?? "").toLowerCase().includes(q)).slice(0, 40);
}
