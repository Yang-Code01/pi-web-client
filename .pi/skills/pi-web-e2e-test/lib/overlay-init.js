(function () {
  if (window.__e2e) return;

  var root = document.createElement("div");
  root.id = "__e2e_overlay";
  root.setAttribute("aria-hidden", "true");
  (document.documentElement || document.body).appendChild(root);

  var style = document.createElement("style");
  style.textContent = window.__E2E_CSS || "";
  (document.head || document.documentElement).appendChild(style);

  function make(cls, tag) {
    var node = document.createElement(tag || "div");
    node.className = cls;
    node.hidden = true;
    root.appendChild(node);
    return node;
  }

  var step = make("e2e-step");
  var stepIndex = document.createElement("span");
  stepIndex.className = "e2e-step-index";
  step.appendChild(stepIndex);
  var stepTitle = document.createElement("span");
  stepTitle.className = "e2e-step-title";
  step.appendChild(stepTitle);

  var caption = make("e2e-caption");

  function svgNode(tag, attrs) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs).forEach(function (name) {
      node.setAttribute(name, attrs[name]);
    });
    return node;
  }

  var cursor = make("e2e-cursor");
  var cursorSvg = svgNode("svg", { viewBox: "0 0 28 32" });
  cursorSvg.appendChild(
    svgNode("path", {
      d: "M3 2 L3 25 L10 18 L15 30 L20 28 L15 16 L24 16 Z",
      fill: "#ffffff",
      stroke: "#111318",
      "stroke-width": "2",
      "stroke-linejoin": "round"
    })
  );
  cursor.appendChild(cursorSvg);

  var ring = make("e2e-ring");
  var ringLabel = document.createElement("span");
  ringLabel.className = "e2e-ring-label";
  ring.appendChild(ringLabel);

  var key = make("e2e-key");
  var keyLabel = document.createElement("span");
  keyLabel.className = "e2e-key-label";
  keyLabel.textContent = "按键";
  key.appendChild(keyLabel);
  var keycap = document.createElement("span");
  keycap.className = "e2e-keycap";
  key.appendChild(keycap);

  var wait = make("e2e-wait");
  var spinner = document.createElement("span");
  spinner.className = "e2e-spinner";
  wait.appendChild(spinner);
  var waitText = document.createElement("span");
  waitText.className = "e2e-wait-text";
  wait.appendChild(waitText);

  var moment = make("e2e-moment");
  var momentDot = document.createElement("span");
  momentDot.className = "e2e-moment-dot";
  moment.appendChild(momentDot);
  var momentText = document.createElement("span");
  moment.appendChild(momentText);

  var scroll = make("e2e-scroll");

  var dragSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  dragSvg.setAttribute("class", "e2e-drag-svg");
  dragSvg.hidden = true;
  var dragLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
  dragLine.setAttribute("stroke", "#ff2d55");
  dragLine.setAttribute("stroke-width", "2.5");
  dragLine.setAttribute("stroke-dasharray", "8 6");
  dragLine.setAttribute("fill", "none");
  dragSvg.appendChild(dragLine);
  var dragStart = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dragStart.setAttribute("r", "5");
  dragStart.setAttribute("fill", "#ff2d55");
  dragSvg.appendChild(dragStart);
  var dragEnd = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dragEnd.setAttribute("r", "5");
  dragEnd.setAttribute("fill", "#ffffff");
  dragEnd.setAttribute("stroke", "#ff2d55");
  dragEnd.setAttribute("stroke-width", "2.5");
  dragSvg.appendChild(dragEnd);
  root.appendChild(dragSvg);
  var dragLabel = make("e2e-drag-label");

  var card = make("e2e-card");
  var cardKicker = document.createElement("div");
  cardKicker.className = "e2e-card-kicker";
  card.appendChild(cardKicker);
  var cardTitle = document.createElement("div");
  cardTitle.className = "e2e-card-title";
  card.appendChild(cardTitle);
  var cardLine = document.createElement("div");
  cardLine.className = "e2e-card-line";
  card.appendChild(cardLine);
  var cardSub = document.createElement("div");
  cardSub.className = "e2e-card-sub";
  card.appendChild(cardSub);

  var cursorX = window.innerWidth / 2;
  var cursorY = window.innerHeight / 2;
  var scrollTimer = 0;

  function easeOutCubic(p) {
    return 1 - Math.pow(1 - p, 3);
  }

  function animate(duration, stepFn) {
    return new Promise(function (resolve) {
      if (!duration || duration <= 0) {
        stepFn(1);
        resolve();
        return;
      }
      var start = performance.now();
      function frame(now) {
        var p = Math.min(1, (now - start) / duration);
        stepFn(easeOutCubic(p));
        if (p < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
  }

  function clampX(x) {
    return Math.max(0, Math.min(window.innerWidth, x));
  }

  function clampY(y) {
    return Math.max(0, Math.min(window.innerHeight, y));
  }

  function show(opts) {
    opts = opts || {};
    stepIndex.textContent = "步骤 " + (opts.index || 1);
    stepTitle.textContent = opts.title || "";
    step.hidden = false;
    if (opts.caption) {
      caption.textContent = opts.caption;
      caption.hidden = false;
    } else {
      caption.hidden = true;
    }
  }

  function hideStep() {
    step.hidden = true;
    caption.hidden = true;
  }

  function cursorTo(x, y, opts) {
    opts = opts || {};
    var tx = clampX(Number(x) || 0);
    var ty = clampY(Number(y) || 0);
    var fromX = cursorX;
    var fromY = cursorY;
    cursor.hidden = false;
    cursorX = tx;
    cursorY = ty;
    return animate(opts.duration == null ? 420 : opts.duration, function (p) {
      var cx = fromX + (tx - fromX) * p;
      var cy = fromY + (ty - fromY) * p;
      cursor.style.transform = "translate(" + (cx - 2) + "px," + (cy - 2) + "px)";
    });
  }

  function ringAt(x, y, w, h, opts) {
    opts = opts || {};
    var pad = opts.pad == null ? 7 : Number(opts.pad);
    var bw = Math.max(18, Number(w) || 18);
    var bh = Math.max(18, Number(h) || 18);
    var left = clampX(x - bw / 2 - pad);
    var top = clampY(y - bh / 2 - pad);
    ring.style.left = left + "px";
    ring.style.top = top + "px";
    ring.style.width = bw + "px";
    ring.style.height = bh + "px";
    ringLabel.textContent = opts.label || "点击";
    if (top < 42) ringLabel.classList.add("below");
    else ringLabel.classList.remove("below");
    ring.hidden = false;
  }

  function clearRing() {
    ring.hidden = true;
  }

  function ripple(x, y) {
    var dot = document.createElement("div");
    dot.className = "e2e-ripple";
    dot.style.left = x + "px";
    dot.style.top = y + "px";
    root.appendChild(dot);
    setTimeout(function () {
      if (dot.parentNode) dot.parentNode.removeChild(dot);
    }, 560);
  }

  function keyAt(text, opts) {
    opts = opts || {};
    keyLabel.textContent = opts.label || "按键";
    keycap.textContent = text || "";
    key.hidden = false;
  }

  function clearKey() {
    key.hidden = true;
  }

  function waitFor(text) {
    waitText.textContent = text || "等待…";
    wait.hidden = false;
  }

  function clearWait() {
    wait.hidden = true;
  }

  function momentAt(text) {
    momentText.textContent = text || "慢放 ×0.25";
    moment.hidden = false;
  }

  function clearMoment() {
    moment.hidden = true;
  }

  function scrollAt(x, y, dy, opts) {
    opts = opts || {};
    var amount = Math.abs(Number(dy) || 0);
    scroll.textContent = "滚动 " + (Number(dy) < 0 ? "↑" : "↓") + " " + amount + "px";
    if (x != null && y != null) {
      scroll.style.left = clampX(Number(x) + 40) + "px";
      scroll.style.top = clampY(Number(y)) + "px";
      scroll.style.right = "auto";
      scroll.style.transform = "translateY(-50%)";
    } else {
      scroll.style.left = "auto";
      scroll.style.top = "50%";
      scroll.style.right = "96px";
      scroll.style.transform = "translateY(-50%)";
    }
    scroll.hidden = false;
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function () {
      scroll.hidden = true;
    }, opts.duration == null ? 1500 : opts.duration);
  }

  function clearScroll() {
    if (scrollTimer) clearTimeout(scrollTimer);
    scroll.hidden = true;
  }

  function dragPath(x1, y1, x2, y2, opts) {
    opts = opts || {};
    var ax = clampX(x1);
    var ay = clampY(y1);
    var bx = clampX(x2);
    var by = clampY(y2);
    dragSvg.setAttribute("viewBox", "0 0 " + window.innerWidth + " " + window.innerHeight);
    dragLine.setAttribute("x1", ax);
    dragLine.setAttribute("y1", ay);
    dragLine.setAttribute("x2", bx);
    dragLine.setAttribute("y2", by);
    dragStart.setAttribute("cx", ax);
    dragStart.setAttribute("cy", ay);
    dragEnd.setAttribute("cx", bx);
    dragEnd.setAttribute("cy", by);
    dragLabel.textContent = opts.label || "拖拽";
    dragLabel.style.left = (ax + bx) / 2 + 8 + "px";
    dragLabel.style.top = (ay + by) / 2 - 30 + "px";
    dragSvg.hidden = false;
    dragLabel.hidden = false;
  }

  function clearDrag() {
    dragSvg.hidden = true;
    dragLabel.hidden = true;
  }

  function showCard(opts) {
    opts = opts || {};
    cardKicker.textContent = opts.kicker || "pi-web-e2e-test";
    cardTitle.textContent = opts.title || "";
    cardSub.textContent = opts.sub || "";
    cardSub.hidden = !opts.sub;
    card.hidden = false;
  }

  function hideCard() {
    card.hidden = true;
  }

  function hideAll() {
    hideStep();
    clearRing();
    clearKey();
    clearWait();
    clearMoment();
    clearScroll();
    clearDrag();
  }

  window.__e2e = {
    root: root,
    show: show,
    hideStep: hideStep,
    cursorTo: cursorTo,
    ring: ringAt,
    clearRing: clearRing,
    ripple: ripple,
    key: keyAt,
    clearKey: clearKey,
    wait: waitFor,
    clearWait: clearWait,
    moment: momentAt,
    clearMoment: clearMoment,
    scroll: scrollAt,
    clearScroll: clearScroll,
    drag: dragPath,
    clearDrag: clearDrag,
    card: showCard,
    hideCard: hideCard,
    hideAll: hideAll
  };
})();
