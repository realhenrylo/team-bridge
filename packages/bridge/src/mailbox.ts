import type { InboundMessage } from '@agent-room/protocol';
import type { WaitResult } from './local';

/** A cursor belongs to one bridge process. Reading mail and notifying are separate. */
export class Mailbox {
  private sequence = 0;
  private entries: { sequence: number; message: InboundMessage }[] = [];
  private waiters = new Set<() => void>();

  constructor(private enabled: () => boolean) {}

  get size() { return this.entries.length; }
  get cursor() { return this.sequence; }

  clear() { this.entries = []; }

  push(message: InboundMessage) {
    if (this.entries.some((entry) => entry.message.id === message.id)) return;
    this.entries.push({ sequence: ++this.sequence, message });
    this.refresh();
  }

  drain(): InboundMessage[] {
    if (!this.enabled()) return [];
    return this.entries.splice(0).map((entry) => entry.message);
  }

  /** Also called when DND is turned off, so existing mail wakes pending waits. */
  refresh() {
    for (const wake of this.waiters) wake();
  }

  wait(after = 0, timeoutMs = 55_000): Promise<WaitResult> {
    return new Promise((resolve) => {
      const result = (): WaitResult => {
        const entry = this.enabled() ? this.entries.find((entry) => entry.sequence > after) : undefined;
        return {
          message: entry ? { id: entry.message.id, from: entry.message.from, preview: entry.message.body.split('\n')[0]!.slice(0, 120) } : null,
          cursor: entry?.sequence ?? after,
          pending: this.enabled() ? this.size : 0,
        };
      };
      const finish = (value: WaitResult) => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(value);
      };
      const wake = () => {
        const value = result();
        if (value.message) finish(value);
      };
      const timer = setTimeout(() => finish(result()), Math.max(1, Math.min(timeoutMs, 60_000)));
      // Register and inspect in the same turn: no gap where incoming mail can be missed.
      this.waiters.add(wake);
      wake();
    });
  }
}
