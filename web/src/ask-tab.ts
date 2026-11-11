export type QueueTab = "needs" | "exec";

export interface TabMemory {
  tab: QueueTab;
  recall: QueueTab | null;
  auto: boolean;
  asksCount: number;
  approvalsCount: number;
}

export type TabEvent =
  | { type: "asks"; count: number }
  | { type: "approvals"; count: number }
  | { type: "user-tab"; tab: QueueTab };

export interface TabContext {
  compact: boolean;
}

export function createTabMemory(tab: QueueTab): TabMemory {
  return { tab, recall: null, auto: false, asksCount: 0, approvalsCount: 0 };
}

export function reduce(memory: TabMemory, event: TabEvent, ctx: TabContext): TabMemory {
  if (event.type === "user-tab") {
    return { ...memory, tab: event.tab, recall: null, auto: false };
  }

  const next = {
    ...memory,
    ...(event.type === "asks"
      ? { asksCount: Math.max(0, event.count) }
      : { approvalsCount: Math.max(0, event.count) }),
  };

  if (next.asksCount > 0 && !ctx.compact && next.tab !== "needs") {
    return {
      ...next,
      tab: "needs",
      recall: next.recall ?? next.tab,
      auto: true,
    };
  }

  if (!ctx.compact && next.asksCount === 0 && next.approvalsCount === 0 && next.recall !== null) {
    return { ...next, tab: next.recall, recall: null, auto: false };
  }

  return next;
}
