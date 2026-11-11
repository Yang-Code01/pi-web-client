export type QueueTab = "needs" | "exec";

export function askQuestionCount(asks: readonly { questions: readonly unknown[] }[]): number {
  return asks.reduce((total, ask) => total + ask.questions.length, 0);
}

export function badgeText(count: number): string {
  if (count <= 0) return "";
  return count > 9 ? "9+" : String(count);
}

export function askBadge(asks: readonly { questions: readonly unknown[] }[]): { count: number; text: string } {
  const count = askQuestionCount(asks);
  return { count, text: badgeText(count) };
}

export interface TabMemory {
  tab: QueueTab;
  recall: QueueTab | null;
  asksCount: number;
  approvalsCount: number;
}

export type TabEvent =
  | { type: "asks"; count: number; arrived: boolean }
  | { type: "approvals"; count: number }
  | { type: "user-tab"; tab: QueueTab };

export interface TabContext {
  compact: boolean;
}

export function createTabMemory(tab: QueueTab): TabMemory {
  return { tab, recall: null, asksCount: 0, approvalsCount: 0 };
}

export function reduce(memory: TabMemory, event: TabEvent, ctx: TabContext): TabMemory {
  if (event.type === "user-tab") {
    return { ...memory, tab: event.tab, recall: null };
  }

  const next = {
    ...memory,
    ...(event.type === "asks"
      ? { asksCount: Math.max(0, event.count) }
      : { approvalsCount: Math.max(0, event.count) }),
  };

  if (event.type === "asks" && event.arrived && next.asksCount > 0 && !ctx.compact && next.tab !== "needs") {
    return { ...next, tab: "needs", recall: next.recall ?? next.tab };
  }

  if (!ctx.compact && next.asksCount === 0 && next.approvalsCount === 0 && next.recall !== null) {
    return { ...next, tab: next.recall, recall: null };
  }

  return next;
}
