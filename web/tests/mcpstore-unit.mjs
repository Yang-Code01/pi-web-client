/**
 * MCP 商店的命名与表单判断（D379）：默认服务名不能都叫 `mcp`，撞名要能看出来。
 *
 *   node --experimental-strip-types --test web/tests/mcpstore-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { checkName, freeName, nameKey, secretVarName, serverNameFor } from "../src/mcpstore.ts";

test("短名够特别就用短名", () => {
  assert.equal(serverNameFor("com.browser-use/browser-use"), "browser-use");
  assert.equal(serverNameFor("io.github.github/github-mcp-server"), "github");
  assert.equal(serverNameFor("dev.fermyon/spin"), "spin");
});

test("短名是泛称时借命名空间，绝不一律叫 mcp", () => {
  assert.equal(serverNameFor("app.worldmonitor/mcp"), "worldmonitor");
  assert.equal(serverNameFor("io.github.BuilderIO/mcp"), "builderio");
  // 命名空间最后一段是两位的国家/公司代码时继续往左找
  assert.equal(serverNameFor("ac.inference.sh/mcp"), "inference");
  assert.equal(serverNameFor("com.pulsemcp/remote"), "pulsemcp");
});

test("真索引里撞得最多的那几个名字会分开", () => {
  // 这四条在 2026-11 的 registry 快照里都叫 `mcp` / `docs` / `memory`，装第二个就会覆盖第一个。
  const names = ["ac.inference.sh/mcp", "ad.pantheon/mcp", "ai.agenticterminal/directory", "ai.counterparts/memory"].map((n) => serverNameFor(n));
  assert.equal(new Set(names).size, names.length, names.join(" "));
});

test("名字只用 pi 认的字符", () => {
  for (const n of ["ac.inference.sh/mcp", "a.b c/d.e", "foo/bar baz", "x/y-z_w.mcp"]) {
    assert.match(serverNameFor(n), /^[A-Za-z0-9_-]+$/, n);
  }
});

test("名字里什么都没剩时退回 mcp，交给 freeName 去加后缀", () => {
  assert.equal(serverNameFor("///"), "mcp");
  assert.equal(serverNameFor("mcp"), "mcp");
});

test("撞名加后缀，且 - 和 _ 视为同一个名字", () => {
  const installed = [{ name: "browser-use" }, { name: "browser_use-2" }];
  assert.equal(freeName("browser-use", installed), "browser-use-3");
  assert.equal(freeName("exa", installed), "exa");
  assert.equal(freeName("Browser-Use", installed), "Browser-Use-3");
});

test("名字键：大小写与 - / _ 归一", () => {
  assert.equal(nameKey(" Foo_Bar "), "foo-bar");
  assert.equal(nameKey("foo-bar"), nameKey("FOO_BAR"));
});

test("表单校验：空名 / 非法字符 / 撞名各有话说", () => {
  const installed = [{ name: "exa" }];
  assert.equal(checkName("   ", installed).ok, false);
  assert.equal(checkName("my server", installed).ok, false);
  assert.equal(checkName("dot.name", installed).ok, false);
  const ok = checkName("mintlify", installed);
  assert.equal(ok.ok, true);
  assert.equal(ok.taken, null);
  const taken = checkName("EXA", installed);
  assert.equal(taken.ok, true);
  assert.equal(taken.taken?.name, "exa");
});

test("密钥变量名与 bridge 的规则一致", () => {
  assert.equal(secretVarName("exa", "EXA_API_KEY", false), "EXA_API_KEY");
  assert.equal(secretVarName("my-server", "Authorization", true), "MY_SERVER_AUTHORIZATION");
  assert.equal(secretVarName("my.server", "x-key", true), "MY_SERVER_X_KEY");
});
