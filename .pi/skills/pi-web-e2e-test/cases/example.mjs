/**
 * A tiny end-to-end case used by the smoke test and as a template.
 *
 * It creates a session, types into the composer and opens/closes the skill
 * palette. The `say` strings are short on purpose: Windows SAPI reads Chinese
 * at roughly 4–6 characters per second, so a long sentence makes the video
 * feel stuck.
 */

export const meta = {
  title: "开新会话 + 输入 + 技能面板",
  expect: "能创建会话、把文字写进 composer、打开并关闭技能面板。",
  slug: "demo"
};

export default async function (h) {
  await h.case({
    id: "new-session-composer",
    title: "开新会话 + 输入 + 技能面板",
    expect: meta.expect
  });

  await h.step("打开「开新会话」", { say: "先点左上角的开新会话。" });
  await h.click('button[data-act="new"]', { label: "开新会话" });
  await h.expect("新会话面板出现", await h.page.locator(".new-sheet").isVisible(), true);

  await h.step("确认创建会话", { say: "直接点新会话，用默认目录。" });
  await h.click('.new-sheet .sheet-foot button.btn.primary', { label: "新会话" });
  await h.waitFor(".composer textarea", { state: "visible", timeout: 20000 });

  await h.step("在输入框里打字", { say: "在输入框里打一句话。" });
  await h.fill(".composer textarea", "这是一个 e2e 示例。", { label: "输入框" });
  await h.expect(
    "输入框里的文字",
    await h.page.locator(".composer textarea").inputValue(),
    "这是一个 e2e 示例。"
  );

  await h.step("打开技能面板", { say: "再点技能，看看面板能不能弹出来。" });
  await h.click('button[data-act="skills"]', { label: "技能" });
  await h.waitFor(".skill-pop", { state: "visible", timeout: 10000 });
  await h.moment("技能面板弹出");
  await h.expect("技能面板可见", await h.page.locator(".skill-pop").isVisible(), true);

  await h.step("用 Esc 关闭面板", { say: "按 Esc 关掉。" });
  await h.press("Escape", { label: "Esc" });
  await h.expect("技能面板已关闭", await h.page.locator(".skill-pop").isVisible(), false);

  await h.endCase();
}
