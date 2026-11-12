/**
 * 标签页网页图标上的未读红点（#397）：主界面（index.html）与独立内网通页面（peer.html）共用。
 * 把页面自带的 `<link rel="icon">` 画到画布上、右上角加一颗红点，再把 href 换成画布的 PNG；
 * 不需要红点时把第一次记下的原 href 原样写回，所以切回页面后图标与原来一模一样。
 */
const DOT_SIZE = 64;
let baseIcon: string | null = null;
let dottedIcon: Promise<string | null> | null = null;
let wanted = false;

export function setFaviconDot(on: boolean): void {
  wanted = on;
  const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) return;
  baseIcon ??= link.getAttribute("href");
  if (!baseIcon) return;
  if (!on) {
    link.setAttribute("href", baseIcon);
    return;
  }
  dottedIcon ??= drawDot(baseIcon);
  // 画图是异步的：等它回来时如果已经不需要红点了（切回前台），就不再写进去。
  void dottedIcon.then((png) => {
    if (wanted && png) link.setAttribute("href", png);
  });
}

function drawDot(icon: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = DOT_SIZE;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0, DOT_SIZE, DOT_SIZE);
      ctx.beginPath();
      ctx.arc(DOT_SIZE - 12, 12, 11, 0, Math.PI * 2);
      ctx.fillStyle = "#ef4444";
      ctx.fill();
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => resolve(null);
    img.src = icon;
  });
}
