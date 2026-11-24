/**
 * 聊天里的 GitHub 链接卡。
 *
 * 为什么需要它：`gh pr create` 的输出落在 `<pre class="bash-out">`（纯文本 `textContent`），
 * 模型复述在正文里的裸 URL 才有锚点。于是「AI 刚建完 PR」这件事，第一手证据恰好是页面上唯一
 * 点不动的地方。卡片补的就是这一下：认出链接 → 挂一张能点的卡（号、标题、+/−、多久以前）。
 *
 * 两条纪律：
 * - **不阻塞渲染**：卡片先挂一个只有号的骨架，滚进视口才去问桥要标题（`IntersectionObserver`），
 *   历史消息里几十张卡不会一次性打出几十个请求。
 * - **同一个 PR 只问一次**：进程内按 `repo#number` 缓存；桥那边还有一层 60 秒缓存。
 *
 * 这个文件被 `chat.ts` import，所以**不能**反过来 import chat.ts（会成环）—— 元素自己建。
 */
import { githubApi } from "./api.ts";
import { ghAge, ghChurn, ghLinksIn, type GhLink, type PullRow } from "./github-shared.ts";
import { tr } from "./i18n/index.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 一行 PR 缓存：重绘聊天时同一张卡不用再问一次桥。 */
const rowCache = new Map<string, PullRow>();
/** 正在飞的请求：同一条消息重绘两次时不要打两发。 */
const inFlight = new Map<string, Promise<PullRow | null>>();

let observer: IntersectionObserver | null = null;
const waiting = new WeakMap<Element, () => void>();

function ensureObserver(): IntersectionObserver | null {
  if (observer) return observer;
  if (typeof IntersectionObserver !== "function") return null;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const run = waiting.get(entry.target);
        if (run) {
          waiting.delete(entry.target);
          observer?.unobserve(entry.target);
          run();
        }
      }
    },
    { rootMargin: "200px 0px" },
  );
  return observer;
}

function hydrate(key: string, repo: string, number: number): Promise<PullRow | null> {
  const hit = rowCache.get(key);
  if (hit) return Promise.resolve(hit);
  const flying = inFlight.get(key);
  if (flying) return flying;
  const p = githubApi
    .card(repo, number)
    .then((r) => {
      rowCache.set(key, r.pull);
      return r.pull;
    })
    .catch(() => null)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

const KIND_LABEL: Record<GhLink["kind"], string> = { pull: "PR", issue: tr("Issue"), commit: tr("Commit") };

/**
 * 把一段文本里的 GitHub 链接折成卡片。`open` 是宿主的「打开面板」入口（只对 PR 有意义）。
 * 没有链接时返回空数组 —— 调用方可以直接展开它。
 */
export function githubCards(text: string, opts: { open: (repo: string, number: number) => void; max?: number }): HTMLElement[] {
  const links = ghLinksIn(text);
  if (links.length === 0) return [];
  const out: HTMLElement[] = [];
  for (const link of links.slice(0, opts.max ?? 3)) {
    out.push(cardFor(link, opts));
  }
  return out;
}

function cardFor(link: GhLink, opts: { open: (repo: string, number: number) => void }): HTMLElement {
  const card = el("button", "ghlink") as HTMLButtonElement;
  card.type = "button";
  const top = el("div", "ghlink-top");
  top.append(el("span", "ghlink-kind", KIND_LABEL[link.kind]), el("span", "ghlink-num", link.kind === "commit" ? link.id.slice(0, 7) : `#${link.id}`));
  const title = el("span", "ghlink-title", link.repo);
  top.append(title);
  const meta = el("div", "ghlink-meta", link.kind === "pull" ? tr("点开在右栏里看") : link.repo);
  card.append(top, meta);

  const number = Number(link.id);
  const isPull = link.kind === "pull" && Number.isFinite(number) && number > 0;
  card.onclick = () => {
    if (isPull) opts.open(link.repo, number);
    else window.open(link.url, "_blank", "noopener");
  };
  if (isPull) {
    card.title = tr("在右栏打开 {p1}#{p2}", { p1: link.repo, p2: String(number) });
    const key = `${link.repo}#${number}`;
    const cached = rowCache.get(key);
    if (cached) fill(card, title, meta, cached);
    else {
      const io = ensureObserver();
      const run = () => {
        void hydrate(key, link.repo, number).then((row) => {
          if (row && card.isConnected) fill(card, title, meta, row);
        });
      };
      if (io) {
        waiting.set(card, run);
        io.observe(card);
      } else run();
    }
  } else {
    card.title = link.url;
  }
  return card;
}

function fill(card: HTMLElement, title: HTMLElement, meta: HTMLElement, row: PullRow): void {
  if (row.title) title.textContent = row.title;
  const age = ghAge(row.updatedAt);
  const parts = [row.author, ghChurn(row.additions, row.deletions), age ? ageLabel(age) : ""].filter(Boolean);
  meta.textContent = parts.join(" · ");
  if (row.draft) card.dataset.draft = "1";
}

function ageLabel(age: { unit: "now" | "min" | "hour" | "day"; n: number }): string {
  if (age.unit === "now") return tr("刚刚");
  if (age.unit === "min") return tr("{p1} 分钟前", { p1: age.n });
  if (age.unit === "hour") return tr("{p1} 小时前", { p1: age.n });
  return tr("{p1} 天前", { p1: age.n });
}
