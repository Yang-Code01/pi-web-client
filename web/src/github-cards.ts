/**
 * 聊天里的 GitHub 链接卡（#661、#666）。
 *
 * 为什么需要它：AI 跑 `gh` 的输出落在工具卡里，那是一块纯文本 —— 唯一「第一手证据」的 URL 恰恰是
 * 页面上点不动的地方。卡片补的就是这一下：认出链接 → 挂一张能点的卡（号、标题、`+/−`、多久以前）。
 *
 * 三处输出都要挂卡，走同一个解析器、同一种卡：
 *  - 工具卡的输出（AI 自己跑的 `gh pr create` / `gh pr view`）
 *  - AI 正文（复述在回答里的链接）
 *  - **用户自己发出的消息**（别人发我一条 PR 链接，我也要能直接在面板里看）
 *
 * #666 起，PR 卡右侧多一颗「代码评审」：主区仍然点开右栏的 GitHub 面板，右边那颗把号送进右栏的
 * 「代码评审」页签。两块是**兄弟**不是嵌套 —— `button` 套 `button` 是非法 DOM，点击还会冒泡到主区。
 * 哪张卡该有这颗钮、灰不灰，问 `reviewAffordance()`（纯函数，单测盯着它）；这里只负责画。
 *
 * 两条纪律：
 * - **不阻塞渲染**：卡片先挂一个只有号的骨架，滚进视口才去问桥要标题（`IntersectionObserver`），
 *   历史消息里几十张卡不会一次性打出几十个请求。
 * - **同一个 PR 只问一次**：进程内按 `repo#number` 缓存；桥那边还有一层 60 秒缓存。
 *
 * 这个文件被 `chat.ts` import，所以**不能**反过来 import chat.ts（会成环）—— 元素自己建。
 */
import { githubApi } from "./api.ts";
import {
  ghAge,
  ghAgeText,
  ghCardLinks,
  ghChurn,
  ghLinksIn,
  reviewAffordance,
  type GhLink,
  type PullRow,
  type ReviewAffordance,
} from "./github-shared.ts";
import { tr } from "./i18n/index.ts";
import "./github-panel.css";

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

/** 宿主给的两个入口（应用没接上评审入口时退化成 #661 那张纯链接卡）。 */
export interface GithubCardHosts {
  /** 主区：在右栏的 GitHub 面板里看这个 PR。 */
  open: (repo: string, number: number) => void;
  /** 右缘那颗「代码评审」：把号交给右栏的评审页签（**不**自动开跑）。 */
  review?: (repo: string, number: number) => void;
  /**
   * 本会话所在仓库（`owner/repo`）；还没问回来时返回空串。
   * 卡片每次重刷都问一遍，所以判据晚到也不用重画聊天。
   */
  sessionRepo?: () => string;
  /** 一张卡最多几张（工具卡输出给 3，正文 / 用户消息给 2）。 */
  max?: number;
}

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
 * 把一段文本里的 GitHub 链接折成卡片。`hosts` 是宿主的两个入口。
 * 没有链接时返回空数组 —— 调用方可以直接展开它。
 *
 * 两种来源：完整 URL（有依据）+ 正文里只写了号的 `PR #669`（猜测，`weak`）。
 * 猜测的那张：仓库用本会话补全；取不到真 PR 就整张拿掉，留着「取不到标题」等于把 issue 报成 PR。
 */
export function githubCards(text: string, hosts: GithubCardHosts): HTMLElement[] {
  const repo = (hosts.sessionRepo?.() ?? "").trim();
  const links = ghCardLinks(text, repo, hosts.max ?? 3);
  if (links.length === 0) return [];
  // URL 自带仓库，给出的 `仓库#号` 是准的：同一段里已经有这条 PR 的链接时，猜出来的那张不再画。
  const exact = new Set(ghLinksIn(text).map((l) => `${l.repo.toLowerCase()}#${l.id}`));
  return links.map((link) => cardFor(link, hosts, exact));
}

function cardFor(link: GhLink, hosts: GithubCardHosts, exact: Set<string>): HTMLElement {
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
  /** 号是正文里猜的（`PR #669`）：仓库要会话补全，也得桥确认是真 PR 才留卡。 */
  const guess = link.weak === true;
  const keyOf = () => `${link.repo.toLowerCase()}#${number}`;
  card.onclick = () => {
    // 猜测卡在会话仓库问回来之前只有号：这时点开只会把空仓库发给桥。
    if (isPull) {
      if (link.repo) hosts.open(link.repo, number);
      return;
    }
    window.open(link.url, "_blank", "noopener");
  };
  if (!isPull) {
    card.title = link.url;
    return card;
  }

  // 仓库可能还没问回来（猜测卡先只有号）：取标题、点开都读 `link.repo` 的当时值。
  const paintTitle = () => {
    card.title = tr("在右栏打开 {p1}#{p2}", { p1: link.repo, p2: String(number) });
  };
  paintTitle();
  // 「这张卡该不该有那颗钮」的 policy 住在纯函数里；这里只问一次，后面重刷时才重新问。
  const affordance = reviewAffordance({ kind: link.kind, cardRepo: link.repo, sessionRepo: hosts.sessionRepo?.() ?? "" });
  const node = withReview(card, link, number, hosts, affordance);
  const fillIt = (row: PullRow) => {
    if (row.title) title.textContent = row.title;
    const age = ghAge(row.updatedAt);
    meta.textContent = [row.author, ghChurn(row.additions, row.deletions), age ? ghAgeText(age) : ""].filter(Boolean).join(" · ");
  };

  let armed = false;
  const arm = () => {
    if (armed) return;
    armed = true;
    // 判据到了才发现同一段文本里已经有这条 PR 的 URL：那张已经画了，猜的这张直接退场。
    if (guess && exact.has(keyOf())) {
      node.remove();
      return;
    }
    paintTitle();
    const run = () => {
      void hydrate(keyOf(), link.repo, number).then((row) => {
        if (!node.isConnected) return;
        if (row) {
          fillIt(row);
          return;
        }
        // 猜错就别画：留着「取不到标题」的破卡，等于把 issue 号报成 PR。URL 知道的那张照旧留。
        if (guess) {
          node.remove();
          return;
        }
        // 取不到就说取不到：吞成 null 的话卡片永远停在只有仓库名的骨架上，用户只能靠点开才发现。
        // 不在这里自动重试 —— 重挂 IntersectionObserver 对已进视口的元素会立刻再发一次回调，变成热循环。
        card.classList.add("ghlink-err");
        meta.textContent = tr("取不到标题，点开看");
      });
    };
    const io = ensureObserver();
    if (io) {
      waiting.set(card, run);
      io.observe(card);
    } else run();
  };

  // 猜出来的卡要先过两道关，**再**看缓存：缓存命中会直接把卡画出来，两条判据一起被绕过。
  if (guess && !link.repo) {
    // 会话仓库还没问回来：先画一张只有号的卡，`refreshGithubCards()` 到了再补仓库、取标题。
    guessSlots.add({ node, link, number, hosts, exact, arm });
    return node;
  }
  if (guess && exact.has(keyOf())) {
    // 仓库已经知道，而同一段文本里已经有这条 PR 的 URL：那张已经画了，猜的这张不画。
    node.remove();
    return node;
  }
  const cached = rowCache.get(keyOf());
  if (cached) {
    fillIt(cached);
    return node;
  }
  arm();
  return node;
}

// ---------------------------------------------------------------------------
// 正文里猜出来的 PR 号（`PR #669` 只有号没有链接）
// ---------------------------------------------------------------------------

/** 仓库晚到、还没开始取标题的猜测卡。 */
interface GuessSlot {
  node: HTMLElement;
  link: GhLink;
  number: number;
  hosts: GithubCardHosts;
  /** 同一段文本里 URL 给出的 `仓库#号`，用来在判据到达后去重。 */
  exact: Set<string>;
  /** 补上仓库之后才跑：挂上 IntersectionObserver 去取标题。 */
  arm: () => void;
}

const guessSlots = new Set<GuessSlot>();

// ---------------------------------------------------------------------------
// #666：右缘那颗「代码评审」
// ---------------------------------------------------------------------------

/** 画出来的评审钮：判据（会话仓库）晚到时按它重刷，不用重画聊天。 */
interface ReviewSlot {
  card: HTMLElement;
  button: HTMLButtonElement;
  /** 卡片自己的链接（不复制 `repo`：猜测卡建的时候仓库还空着，判据到了才补上）。 */
  link: GhLink;
  number: number;
  hosts: GithubCardHosts;
}

const reviewSlots = new Set<ReviewSlot>();

function applyReview(slot: ReviewSlot, affordance: ReviewAffordance): void {
  const session = (slot.hosts.sessionRepo?.() ?? "").trim();
  slot.button.disabled = affordance.disabled;
  slot.button.setAttribute("aria-label", tr("代码评审 {p1}#{p2}", { p1: slot.link.repo, p2: String(slot.number) }));
  slot.button.title =
    affordance.reason === "foreign"
      ? tr("只能评本会话仓库的 PR：这张卡是 {p1}，本会话是 {p2}", { p1: slot.link.repo, p2: session })
      : tr("在右栏的「代码评审」里评这个 PR（不自动开跑）");
}

/** 判据变了（会话仓库问回来了）之后重算一次。 */
function paintReview(slot: ReviewSlot): void {
  applyReview(slot, reviewAffordance({ kind: "pull", cardRepo: slot.link.repo, sessionRepo: slot.hosts.sessionRepo?.() ?? "" }));
}

/** 把一张只剩主区的 PR 卡包成「主区 + 右缘评审钮」。宿主没接评审入口时原样返回。 */
function withReview(
  card: HTMLButtonElement,
  link: GhLink,
  number: number,
  hosts: GithubCardHosts,
  affordance: ReviewAffordance,
): HTMLElement {
  if (!affordance.show || !hosts.review) return card;
  // 顺手清掉已经从页面上拿掉的卡：`refreshGithubCards()` 只在判据**第一次**到达时跑一次，
  // 之后不再有机会收尸，聊天重绘几十轮就会攒一堆脱离文档的 slot。
  for (const stale of reviewSlots) if (!stale.card.isConnected) reviewSlots.delete(stale);

  const review = el("button", "ghlink-review", tr("代码评审")) as HTMLButtonElement;
  review.type = "button";
  // 点开读 `link.repo` 的当时值：猜测卡的仓库要等会话判据到了才补上。
  review.onclick = () => {
    if (review.disabled) return;
    hosts.review?.(link.repo, number);
  };

  const box = el("div", "ghcard");
  box.append(card, review);
  const slot: ReviewSlot = { card: box, button: review, link, number, hosts };
  reviewSlots.add(slot);
  applyReview(slot, affordance);
  return box;
}

/**
 * 会话仓库问回来之后叫一次：猜测卡补上仓库、开始取标题，已经画出来的评审钮重刷一遍。
 * 顺手清掉已经从页面上拿掉的卡 —— 聊天重绘之后旧卡不会再回来。
 */
export function refreshGithubCards(): void {
  // 先补猜测卡的仓库：它们要有仓库才能去问桥「这个号是不是真 PR」。
  for (const slot of guessSlots) {
    if (!slot.node.isConnected) {
      guessSlots.delete(slot);
      continue;
    }
    const repo = (slot.hosts.sessionRepo?.() ?? "").trim();
    if (!repo) continue;
    guessSlots.delete(slot);
    slot.link.repo = repo;
    slot.link.url = `https://github.com/${repo}/pull/${slot.number}`;
    slot.arm();
  }
  for (const slot of reviewSlots) {
    if (!slot.card.isConnected) {
      reviewSlots.delete(slot);
      continue;
    }
    paintReview(slot);
  }
}

/** 测试用：清掉缓存（换一套假桥之后不能让上一张卡的结果留着）。 */
export function resetGithubCards(): void {
  rowCache.clear();
  inFlight.clear();
  reviewSlots.clear();
  guessSlots.clear();
}
