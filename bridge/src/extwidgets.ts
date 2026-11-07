/**
 * 扩展小部件里混进来的「协议载荷」：认出来就别往页面上铺。
 *
 * 有些扩展在 RPC 模式下没法画组件，于是把给**客户端解析**的一行 JSON 当成 widget 文本推过来
 * （`ctx.ui.setWidget(key, ["PREFIX:{…}"])`）。TUI 那边有对应渲染器，会把它画成进度树；
 * 桥这边只是不透明文本，收下就等于在输入框上方贴一坨原始 JSON —— 而且桥还把每行截到 400 字，
 * 截断后的载荷连解析都做不了，只剩噪音。
 *
 * 已知的两处（pi-subagents）：
 *   - `subagent-async`   → `PI_SUBAGENT_ASYNC_JSON:{kind:"pi-subagents.async-status-snapshot",…}`
 *   - `subagent-inspect` → `PI_SUBAGENT_INSPECT_JSON:{kind:"pi-subagents.inspect-reply",…}`
 *
 * 「后台子代理在跑」这件事页面上另有正经来源（D170 的 `session.bg` → `.bg-bar`），所以丢掉它
 * 不损失信息。**只认大写前缀 + 冒号这种明确的哨兵写法**：普通 widget（TODO 列表、脚注）照旧透传。
 */
const PROTOCOL_WIDGET_PREFIXES = ["PI_SUBAGENT_ASYNC_JSON:", "PI_SUBAGENT_INSPECT_JSON:"];

/** 这一组 widget 行是不是协议载荷（哨兵前缀出现在任意一行的开头）。 */
export function isProtocolWidgetLines(lines: readonly string[]): boolean {
  return lines.some((line) => {
    const head = line.trimStart();
    return PROTOCOL_WIDGET_PREFIXES.some((prefix) => head.startsWith(prefix));
  });
}
