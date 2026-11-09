/*
 * 原型：按钮可见性（#281）。一次性代码，只为回答「这张表长什么样」。
 * 真代码要重写：这里没有 i18n、没有 WS、没有指针拖拽，状态只在内存里。
 */
const GROUPS = [
  { key: "top", label: "顶栏按钮" },
  { key: "bottom", label: "输入框下沿" },
];

const ITEMS = [
  { id: "artifacts", group: "top", ic: "📂", name: "产物", hint: "没开会话时不显示" },
  { id: "terminal", group: "top", ic: ">_", name: "终端" },
  { id: "files", group: "top", ic: "📁", name: "文件管理器", hint: "没开会话时不显示；手机上默认收起" },
  { id: "notes", group: "top", ic: "🐞", name: "bug" },
  { id: "peer", group: "top", ic: "🌐", name: "内网通" },
  { id: "scratch", group: "top", ic: "💭", name: "随手问" },
  { id: "jira", group: "top", ic: "🔷", name: "Jira" },
  { id: "skills", group: "bottom", ic: "", name: "技能" },
  { id: "ext", group: "bottom", ic: "", name: "扩展" },
  { id: "attach", group: "bottom", ic: "", name: "文件" },
  { id: "model", group: "bottom", ic: "", name: "模型" },
];

const VARIANTS = {
  A: { name: "双列清单", render: renderA },
  B: { name: "实时预览", render: renderB },
  C: { name: "三态分段", render: renderC },
};

/** 唯一的真状态：键缺失＝默认行为，false＝隐藏，true＝显式显示（窄屏也露出来）。 */
const state = { chrome: {} };
let narrowPreview = false;

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function visible(id, narrow = false) {
  const v = state.chrome[id];
  if (v === true) return true;
  if (v === false) return false;
  return !(narrow && id === "files");
}

/** A/B 的勾：勾上＝显示，取消＝隐藏；再勾回来就是显式的 true。 */
function setChecked(id, on) {
  // 只能看写进去的键，不能拿「现在看不看得见」去比：窄屏下那颗正被 CSS 收着，
  // 用户点它就是要写一条显式的 true —— 比出来相等就提前 return，这条键永远写不进去。
  state.chrome[id] = on;
  paint();
}

function setTri(id, v) {
  if (v === "auto") delete state.chrome[id];
  else state.chrome[id] = v === "on";
  paint();
}

function triOf(id) {
  const v = state.chrome[id];
  return v === true ? "on" : v === false ? "off" : "auto";
}

function clearGroup(group) {
  for (const it of ITEMS) if (it.group === group) delete state.chrome[it.id];
  paint();
}

// ---------------------------------------------------------------- 共用零件
function head(text, group) {
  const box = h("div", "vis-head");
  box.append(h("div", "levels-label", text));
  const all = h("button", "vis-all", "全部显示");
  all.onclick = () => clearGroup(group);
  box.append(all);
  return box;
}

function note(text) {
  return h("div", "vis-note", text);
}

/** 把「用户存进去的那份 JSON」原样摊在界面上——原型要看的就是这个。 */
function stateBox() {
  const box = h("div", "levels");
  box.append(h("div", "levels-label", "存进桥端的那份"));
  const keys = Object.keys(state.chrome).sort();
  const body = keys.length
    ? `{\n  ${keys.map((k) => `"${k}": ${state.chrome[k]}`).join(",\n  ")}\n}`
    : "{}";
  const pre = h("pre", "vis-state");
  pre.textContent = `chrome = ${body}`;
  box.append(pre, note("没碰过的项不写键 —— 缺键＝照默认走（手机上文件管理器默认收起）。"));
  return box;
}

// ---------------------------------------------------------------- A 双列清单
function renderA() {
  const blocks = [];
  for (const g of GROUPS) {
    const box = h("div", "levels");
    box.append(head(g.label, g.key));
    const grid = h("div", "vis-grid");
    for (const it of ITEMS.filter((i) => i.group === g.key)) {
      const row = h("label", "vis-row");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = visible(it.id);
      input.onchange = () => setChecked(it.id, input.checked);
      const box2 = h("span", "vis-box", "✓");
      const name = h("span", "vis-name");
      name.append(h("span", "vis-ic", it.ic || "·"));
      const text = h("span");
      text.append(h("strong", null, it.name));
      if (it.hint) text.append(h("span", "vis-sub", it.hint));
      name.append(text);
      row.append(input, box2, name);
      row.classList.toggle("off", !visible(it.id));
      grid.append(row);
    }
    box.append(grid);
    blocks.push(box);
  }
  return blocks;
}

// ---------------------------------------------------------------- B 实时预览
function renderB() {
  const blocks = [];

  // 1. 迷你预览：点哪颗哪颗就消失，所见即所得。
  const pvBox = h("div", "levels");
  const head1 = h("div", "vis-head");
  head1.append(h("div", "levels-label", "顶栏 / 下沿预览"));
  pvBox.append(head1);

  const pv = h("div", "pv");
  pv.style.setProperty("--pv-w", narrowPreview ? "300px" : "100%");
  const top = h("div", "pv-top");
  top.append(h("span", "pv-title", "pi · 会话名"));
  for (const it of ITEMS.filter((i) => i.group === "top")) {
    const b = h("button", "pv-btn");
    if (it.ic) b.append(h("span", "ic", it.ic));
    b.append(h("span", null, it.name));
    if (!it.ic) b.classList.add("pv-aa");
    b.hidden = !visible(it.id, narrowPreview);
    b.title = `点一下隐藏「${it.name}」`;
    b.onclick = () => setChecked(it.id, false);
    top.append(b);
  }
  const aa = h("button", "pv-btn pv-aa", "Aa");
  aa.title = "外观与语言：这颗不能关（关了就回不到这张表）";
  aa.disabled = true;
  aa.style.opacity = "0.55";
  top.append(aa);

  const comp = h("div", "pv-comp");
  comp.append(h("span", "pv-in"));
  for (const it of ITEMS.filter((i) => i.group === "bottom")) {
    const t = h("span", it.id === "model" ? "pv-model" : "pv-tool", it.name);
    t.hidden = !visible(it.id, narrowPreview);
    comp.append(t);
  }
  pv.append(top, comp);

  const bar = h("div", "pv-bar");
  bar.append(h("span", null, "预览宽度"));
  const seg = h("span", "seg-mini");
  for (const [v, label] of [
    ["wide", "桌面"],
    ["narrow", "手机 390"],
  ]) {
    const b = h("button", narrowPreview === (v === "narrow") ? "on" : null, label);
    b.onclick = () => {
      narrowPreview = v === "narrow";
      paint();
    };
    seg.append(b);
  }
  bar.append(seg, h("span", null, "点预览里的按钮可以直接关掉"));
  pvBox.append(pv, bar, note("手机宽度下「文件管理器」自己会消失 —— 想让它留着，就在下面把它点亮。预览里那排按钮排不下时自己也左右滚（跟真顶栏一样）。"));
  blocks.push(pvBox);

  // 2. 方块墙：一排会亮的开关。
  const wall = h("div", "levels");
  const lead = h("div", "vis-head");
  lead.append(h("div", "levels-label", "点一下就收起来，再点一下放回来"));
  wall.append(lead);
  for (const g of GROUPS) {
    wall.append(h("div", "levels-label", g.label));
    const tiles = h("div", "vis-tiles");
    for (const it of ITEMS.filter((i) => i.group === g.key)) {
      // 窄屏预览下「自动」收起的那颗此刻本来就看不见：方块跟着灭，点一下才是显式打开。
      const on = visible(it.id, narrowPreview);
      const t = h("button", `vis-tile${on ? "" : " off"}`);
      t.append(h("span", "t-ic", it.ic || "·"), h("span", "t-name", it.name), h("span", "t-eye", on ? "●" : "○"));
      t.title = on ? `隐藏「${it.name}」` : `显示「${it.name}」`;
      t.onclick = () => setChecked(it.id, !on);
      tiles.append(t);
    }
    wall.append(tiles);
  }
  const allAll = h("button", "vis-all", "恢复默认（全部显示）");
  allAll.onclick = () => {
    state.chrome = {};
    paint();
  };
  wall.append(allAll);
  blocks.push(wall);
  return blocks;
}

// ---------------------------------------------------------------- C 三态分段
function renderC() {
  const blocks = [];
  for (const g of GROUPS) {
    const box = h("div", "levels");
    box.append(head(g.label, g.key));
    box.append(
      note(
        g.key === "top"
          ? "显示＝一直露着；自动＝照默认走（手机上「文件管理器」默认收起）；隐藏＝从这里拿掉。"
          : "下沿这四颗没有默认收起的行为，自动与显示在这里一样。"
      )
    );
    for (const it of ITEMS.filter((i) => i.group === g.key)) {
      const row = h("div", "vis-tri-row");
      const nameBox = h("div", "vis-tri-name");
      const line = h("span", "n");
      line.append(h("span", "vis-ic", it.ic || "·"), h("span", null, it.name));
      nameBox.append(line);
      if (it.hint) nameBox.append(h("span", "vis-hint", it.hint));

      const cur = triOf(it.id);
      const seg = h("div", "seg");
      for (const [v, label] of [
        ["on", "显示"],
        ["auto", "自动"],
        ["off", "隐藏"],
      ]) {
        const b = h("button", cur === v ? "on" : null, label);
        b.dataset.v = v;
        b.setAttribute("aria-pressed", String(cur === v));
        b.onclick = () => setTri(it.id, v);
        seg.append(b);
      }
      row.append(nameBox, seg);
      box.append(row);
    }
    blocks.push(box);
  }
  return blocks;
}

// ---------------------------------------------------------------- 装配
const slot = document.getElementById("slot");
const sheet = document.querySelector(".sheet");

function currentVariant() {
  const v = new URLSearchParams(location.search).get("variant");
  return VARIANTS[v] ? v : "A";
}

function paint() {
  const key = currentVariant();
  slot.replaceChildren(...VARIANTS[key].render(), stateBox());
  // 切换条
  const label = document.getElementById("pv-label");
  label.replaceChildren(h("b", null, key), document.createTextNode(`（${VARIANTS[key].name}）`));
}

function go(dir) {
  const keys = Object.keys(VARIANTS);
  const i = keys.indexOf(currentVariant());
  const next = keys[(i + dir + keys.length) % keys.length];
  const url = new URL(location.href);
  url.searchParams.set("variant", next);
  history.replaceState(null, "", url);
  paint();
  scrollToSection();
}

function scrollToSection() {
  if (!sheet) return;
  const top = slot.getBoundingClientRect().top - sheet.getBoundingClientRect().top + sheet.scrollTop;
  sheet.scrollTop = Math.max(0, top - 24);
}

// 键盘左右换版（输入框里不算）
addEventListener("keydown", (ev) => {
  const t = ev.target;
  if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (ev.key === "ArrowLeft") go(-1);
  else if (ev.key === "ArrowRight") go(1);
});

document.getElementById("pv-prev").onclick = () => go(-1);
document.getElementById("pv-next").onclick = () => go(1);

// 关掉 sheet 看整体 / 从顶栏 Aa 再打开
const back = document.querySelector(".sheet-back");
for (const b of document.querySelectorAll("[data-close]")) {
  b.onclick = () => back.classList.add("hidden");
}
for (const b of document.querySelectorAll("[data-open]")) {
  b.onclick = () => {
    back.classList.remove("hidden");
    requestAnimationFrame(scrollToSection);
  };
}
if (back) {
  back.addEventListener("click", (ev) => {
    if (ev.target === back) back.classList.add("hidden");
  });
}
addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") back.classList.add("hidden");
});

paint();
scrollToSection();
// 字体落定后高度会变，第一次的滚动位置就不准了
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => requestAnimationFrame(scrollToSection));
setTimeout(scrollToSection, 260);
