/**
 * 本机活动（D299 / P4）：决定 announce 里那个 `status`。
 *
 * 为什么是「空闲推导」而不是一个手动状态开关：内网通是两台机器直连，没人会去点一个
 * 「我现在忙」——但每个人都会把窗口切走。所以只做 online / away 两档，away 由
 * 「10 分钟没有任何操作」推出来，页面每次交互打一次 `/presence`。
 *
 * 手动改状态不做（QQ 有，我们没有那个使用场景，加了反而多一个要维护的状态机）。
 */
export const AWAY_MS = 10 * 60_000;

export type LocalStatus = "online" | "away";

export class LocalActivity {
  private at = Date.now();

  /** 任何「这台机器上有人在动」的证据：页面心跳、发消息、收到消息。 */
  touch(): void {
    this.at = Date.now();
  }

  idleMs(): number {
    return Date.now() - this.at;
  }

  status(): LocalStatus {
    return this.idleMs() > AWAY_MS ? "away" : "online";
  }
}
