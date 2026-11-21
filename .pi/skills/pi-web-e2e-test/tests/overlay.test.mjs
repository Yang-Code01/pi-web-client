import assert from "node:assert/strict";
import test from "node:test";
import { overlayScript } from "../lib/overlay.mjs";

test("overlay script injects the controller and its styles", () => {
  const script = overlayScript();
  assert.match(script, /window\.__E2E_CSS/);
  assert.match(script, /window\.__e2e = \{/);
  assert.match(script, /#__e2e_overlay/);
  assert.match(script, /e2e-ring/);
  assert.match(script, /pointer-events: none/);
  assert.doesNotMatch(script, /<\/script>/i);
});

test("overlay exposes every action used by the driver", () => {
  const script = overlayScript();
  for (const name of [
    "show",
    "hideStep",
    "cursorTo",
    "ring",
    "clearRing",
    "ripple",
    "key",
    "clearKey",
    "wait",
    "clearWait",
    "moment",
    "clearMoment",
    "scroll",
    "clearScroll",
    "drag",
    "clearDrag",
    "card",
    "hideCard",
    "hideAll"
  ]) {
    assert.match(script, new RegExp(`${name}: ${name}|${name}: `));
  }
});
