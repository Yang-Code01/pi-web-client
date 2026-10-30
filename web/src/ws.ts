type Handler = (msg: any) => void;

export class Socket {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private statusHandlers = new Set<(s: "open" | "closed" | "connecting") => void>();
  private retry = 0;
  private queue: string[] = [];
  status: "open" | "closed" | "connecting" = "closed";

  connect(): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.setStatus("connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.setStatus("open");
      for (const msg of this.queue.splice(0)) ws.send(msg);
    };
    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      for (const h of this.handlers) h(msg);
    };
    ws.onclose = () => {
      this.setStatus("closed");
      this.ws = null;
      const delay = Math.min(8000, 600 * 2 ** this.retry);
      this.retry += 1;
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  private setStatus(s: "open" | "closed" | "connecting"): void {
    this.status = s;
    for (const h of this.statusHandlers) h(s);
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onStatus(handler: (s: "open" | "closed" | "connecting") => void): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  send(msg: unknown): void {
    const data = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
    else this.queue.push(data);
  }
}
