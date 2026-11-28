/**
 * `web/src/pastefly.ts` 的契约（D446）：
 *
 *   1. 曲线必须跟 `mac-base.css` 的 `--mac-spring` 一致（WAAPI 不认 `var()`，只能抄字面量，抄了就会漂）；
 *   2. 只给真要飞的几片拼 data URL（一次贴十几张大图不该拼十几条长字符串）；
 *   3. 收尾不挂在 onfinish 上 —— 动画被 cancel 也要摘幽灵、拆层、让 Promise 落定；
 *   4. 徽标不叠动画、不互相摘闪（连贴两次）；
 *   5. 动效坏了（`animate` 抛错 / 没有 WAAPI）不许连累贴图本身，也不许留 unhandled rejection。
 *
 * 3–5 需要 DOM 与 WAAPI。浏览器里那份真几何由 `probes/paste-fly-in.mjs` 管（要隔离桥）；
 * 这里用一套够用的假 DOM 把「谁在什么时候被摘掉」这条逻辑在 node 里钉住，跑 typecheck 就能发现回归。
 *
 * Run: node --experimental-strip-types --test web/tests/pastefly-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPRING, badgeLanded, flyImagesToBadge } from "../src/pastefly.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(HERE, "..", "src", "mac-base.css"), "utf8");

/** 取 `--name: value;` 里的 value（值本身没有分号，够用）。 */
const cssVar = (name) => {
  const hit = CSS.match(new RegExp(`--${name}:\\s*([^;]+);`));
  return hit ? hit[1].trim() : "";
};

// ---------------------------------------------------------------- 假 DOM（够 pastefly 用就行）

/** 假节点：`append` / `remove` / `childElementCount` / `querySelector(":scope > .x")` / `animate`。 */
function node(tag, dom) {
  const el = {
    tagName: tag,
    className: "",
    src: "",
    alt: "",
    children: [],
    parent: null,
    classList: {
      set: new Set(),
      add(c) {
        el.classList.set.add(c);
      },
      remove(c) {
        el.classList.set.delete(c);
      },
      contains(c) {
        return el.classList.set.has(c);
      },
    },
    append(...kids) {
      for (const kid of kids) {
        kid.parent = el;
        el.children.push(kid);
      }
    },
    remove() {
      if (!el.parent) return;
      el.parent.children = el.parent.children.filter((c) => c !== el);
      el.parent = null;
    },
    get childElementCount() {
      return el.children.length;
    },
    querySelector(sel) {
      const cls = sel.replace(":scope > ", "").replace(/^\./, "");
      return el.children.find((c) => c.className === cls) ?? null;
    },
    getBoundingClientRect() {
      return { left: 800, top: 600, width: 80, height: 22, right: 880, bottom: 622 };
    },
    animate(keyframes, options) {
      if (dom.throwOnAnimate) throw new Error("animate 不支持这组关键帧");
      const ctrl = {};
      const anim = {
        keyframes,
        options,
        cancelled: false,
        finished: new Promise((resolve, reject) => {
          ctrl.resolve = resolve;
          ctrl.reject = reject;
        }),
        cancel() {
          anim.cancelled = true;
          ctrl.reject(new Error("AbortError"));
        },
      };
      // 真的 `Animation` 在没人读 `.finished` 时不会冒出 unhandled rejection；假货也照这个来。
      anim.finished.catch(() => {});
      dom.created.push({ el, anim, ctrl });
      return anim;
    },
  };
  return el;
}

/** 一套假 DOM：`document.createElement`、`window.setTimeout/clearTimeout`、`matchMedia`。 */
function fakeDom({ throwOnAnimate = false } = {}) {
  const dom = { created: [], timers: [], throwOnAnimate };
  const realDocument = globalThis.document;
  const realWindow = globalThis.window;
  const realMatchMedia = globalThis.matchMedia;
  globalThis.document = { createElement: (tag) => node(tag, dom) };
  globalThis.window = {
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      dom.timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) timer.cleared = true;
    },
  };
  delete globalThis.matchMedia; // 没有 reduced-motion 就是「正常动」
  dom.root = node("div", dom);
  dom.badge = node("button", dom);
  /** 只属于徽标的动画（幽灵的不算）。 */
  dom.badgeAnims = () => dom.created.filter((c) => c.el === dom.badge);
  /** 让所有幽灵动画「正常结束」。 */
  dom.finishFlights = () => dom.created.filter((c) => c.el.className === "ghost").forEach((c) => c.ctrl.resolve());
  dom.restore = () => {
    if (realDocument === undefined) delete globalThis.document;
    else globalThis.document = realDocument;
    if (realWindow === undefined) delete globalThis.window;
    else globalThis.window = realWindow;
    if (realMatchMedia !== undefined) globalThis.matchMedia = realMatchMedia;
  };
  return dom;
}

/** 待发图片：`data` 故意给短串，断言只关心「有没有拼、拼给谁」。 */
const shots = (n) => Array.from({ length: n }, (_, i) => ({ data: `AA${i}`, mimeType: "image/png" }));

const opts = (dom) => ({ badge: dom.badge, origin: null, host: () => dom.root, scale: () => 1 });

// ---------------------------------------------------------------- 1. 曲线对账

test("SPRING 跟 --mac-spring 是同一条曲线", () => {
  assert.equal(cssVar("mac-spring"), SPRING);
});

// ---------------------------------------------------------------- 2. 提前返回

test("node 里 import 安全（模块没有在做顶层碰 DOM）", () => {
  assert.equal(typeof globalThis.matchMedia, "undefined");
  assert.equal(typeof flyImagesToBadge, "function");
});

test("源列表为空：连 host 都不问（贴图之外没人该被拖进来）", async () => {
  let asked = 0;
  await flyImagesToBadge([], { badge: null, origin: null, host: () => (asked++, null), scale: () => 1 });
  assert.equal(asked, 0);
});

test("prefers-reduced-motion：两个入口都不动手，也不拼 data URL", async () => {
  globalThis.matchMedia = () => ({ matches: true });
  let touched = 0;
  const badge = {
    classList: { add: () => touched++, remove: () => touched++ },
    animate: () => touched++,
  };
  badgeLanded(badge);
  const images = shots(2);
  let mapped = 0;
  // 拼 data URL 用到的字段被 getter 拦一下：reduced-motion 下它一次都不该被读到。
  const watched = images.map((img) => ({
    get mimeType() {
      mapped++;
      return img.mimeType;
    },
    get data() {
      mapped++;
      return img.data;
    },
  }));
  await flyImagesToBadge(watched, { badge, origin: null, host: () => (touched++, null), scale: () => 1 });
  assert.equal(touched, 0);
  assert.equal(mapped, 0);
  delete globalThis.matchMedia;
});

// ---------------------------------------------------------------- 3. 只给要飞的几片拼图

test("六张只拼四片 data URL（MAX_GHOSTS 之后不再拼）", async () => {
  const dom = fakeDom();
  try {
    let mapped = 0;
    const images = shots(6).map((img) => ({
      get mimeType() {
        mapped++;
        return img.mimeType;
      },
      get data() {
        mapped++;
        return img.data;
      },
    }));
    const done = flyImagesToBadge(images, opts(dom));
    const layer = dom.root.children[0];
    assert.equal(layer.className, "paste-fly");
    assert.equal(layer.childElementCount, 4);
    assert.equal(mapped, 8); // 4 片 × (mimeType + data)
    dom.finishFlights();
    await done;
  } finally {
    dom.restore();
  }
});

// ---------------------------------------------------------------- 4. 收尾：正常结束 / 被取消

test("飞完一张就摘一张，最后一张落地后整层拆掉、徽标只弹一次", async () => {
  const dom = fakeDom();
  try {
    const done = flyImagesToBadge(shots(3), opts(dom));
    const layer = dom.root.children[0];
    assert.equal(layer.childElementCount, 3);
    // 一张一张落：前面两张落地时层还得留着（第三张还在飞）。
    dom.created.filter((c) => c.el.className === "ghost")[1].ctrl.resolve();
    await Promise.resolve();
    assert.equal(layer.childElementCount, 2);
    assert.equal(dom.root.children.length, 1);
    dom.finishFlights();
    await done;
    assert.equal(dom.root.children.length, 0, "层要从 #app 里摘掉");
    assert.equal(dom.badgeAnims().length, 1, "落地只弹一次");
    assert.ok(dom.badge.classList.contains("flash"), "实底闪挂上");
    assert.equal(dom.badgeAnims()[0].anim.keyframes[0].transform, "scale(.62)", "弹的是徽标落地那组关键帧");
  } finally {
    dom.restore();
  }
});

test("动画被取消（#app 重建 / 标签页被清理）：幽灵与层照样收干净，Promise 照样落定", async () => {
  const dom = fakeDom();
  try {
    const done = flyImagesToBadge(shots(2), opts(dom));
    const layer = dom.root.children[0];
    assert.equal(layer.childElementCount, 2);
    for (const c of dom.created.filter((x) => x.el.className === "ghost")) c.anim.cancel();
    await done; // 不 reject、不悬着
    assert.equal(dom.root.children.length, 0);
    assert.equal(dom.badgeAnims().length, 1, "取消也算这一批停下，徽标照样落地");
  } finally {
    dom.restore();
  }
});

// ---------------------------------------------------------------- 5. 徽标不叠动画、不互相摘闪

test("连贴两次：上一条动画被 cancel、上一个 .flash 定时器被清掉", () => {
  const dom = fakeDom();
  try {
    badgeLanded(dom.badge);
    const first = dom.badgeAnims()[0];
    const firstTimer = dom.timers[0];
    badgeLanded(dom.badge);
    assert.equal(first.anim.cancelled, true, "上一条动画被 cancel");
    assert.equal(firstTimer.cleared, true, "上一个定时器被清掉（否则它会把这次的闪提前摘掉）");
    assert.equal(dom.badge.classList.contains("flash"), true);
    dom.timers[1].fn(); // 260ms 到了
    assert.equal(dom.badge.classList.contains("flash"), false, "到点自己摘掉");
    assert.equal(dom.timers[1].ms, 260);
  } finally {
    dom.restore();
  }
});

// ---------------------------------------------------------------- 6. 动效坏了不连累贴图

test("animate 抛错：徽标不炸、闪照样挂；飞行不留幽灵、Promise 不 reject", async () => {
  const dom = fakeDom({ throwOnAnimate: true });
  try {
    badgeLanded(dom.badge);
    assert.equal(dom.badge.classList.contains("flash"), true, "没有 WAAPI 时至少还有实底闪");
    const done = flyImagesToBadge(shots(2), opts(dom));
    await done; // 不许 reject：app.ts 那边是 void 掉的
    assert.equal(dom.root.children.length, 0, "飞不起来的幽灵当场收掉，不留空层");
  } finally {
    dom.restore();
  }
});
