import "./styles.css";
import { api } from "./api.ts";
import { App } from "./app.ts";
import type { Me } from "./types.ts";
import { applyLang, detectLang, errText, isLang, tr, type Lang } from "./i18n/index.ts";

/**
 * 登录页在 App 之前就画出来了，所以语言得在这时先定下来（D110）：读 `pi.prefs.lang`,
 * 没存过/非法就问浏览器。App 的构造函数会再 apply 一遍，两边同源，不会打架。
 */
function bootLang(): Lang {
  let lang: Lang = detectLang();
  try {
    const p = JSON.parse(localStorage.getItem("pi.prefs") ?? "null");
    if (isLang(p?.lang)) lang = p.lang;
  } catch {
    // 坏掉的 prefs 就当没存过。
  }
  applyLang(lang);
  return lang;
}

function loginScreen(onSuccess: (me: Me) => void): void {
  const app = document.getElementById("app")!;
  app.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "login";
  const form = document.createElement("form");
  const h1 = document.createElement("h1");
  h1.textContent = "pi";
  const p = document.createElement("p");
  p.textContent = tr("输入口令。第一次启动时，bridge 会在终端里打印一个。");
  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "current-password";
  input.placeholder = tr("口令");
  const err = document.createElement("div");
  err.className = "err";
  const btn = document.createElement("button");
  btn.className = "btn primary";
  btn.type = "submit";
  btn.textContent = tr("进入");
  form.append(h1, p, input, err, btn);
  wrap.append(form);
  app.append(wrap);
  input.focus();

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    btn.disabled = true;
    try {
      await api.login(input.value.trim());
      onSuccess(await api.me());
    } catch (e: any) {
      err.textContent = errText(e);
    } finally {
      btn.disabled = false;
    }
  };
}

async function boot(): Promise<void> {
  bootLang();
  let me: Me | null = null;
  try {
    me = await api.me();
  } catch {
    me = null;
  }
  if (!me) {
    loginScreen((fresh) => {
      void start(fresh);
    });
    return;
  }
  await start(me);
}

async function start(me: Me): Promise<void> {
  new App(me);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* push is optional */
    });
  }
}

void boot();
