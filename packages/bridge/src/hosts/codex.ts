import { execFile } from 'node:child_process';
import type { Mailbox } from '../mailbox';

/** Only a notification is queued. Colleague content remains MCP tool output. */
export const CODEX_NOTIFICATION = 'agent-room has pending colleague messages. Call agent_room_read_messages to read them and handle any task within your existing instructions and permissions. If already read, do not process them twice.';

export function codexThread(meta: Record<string, unknown> | undefined): string {
  const id = meta?.threadId;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw new Error('Codex did not supply a valid threadId in MCP request metadata. Update Codex; no identity was guessed.');
  }
  return id;
}

export function queueCodex(thread: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('codex', ['queue', '--thread', thread, '--message', CODEX_NOTIFICATION],
      { timeout: 15_000, maxBuffer: 64 * 1024 }, (error) => error ? reject(error) : resolve());
  });
}

/** One in-flight notification; failed queue attempts retain the mailbox cursor. */
export class CodexListener {
  enabled = false;
  error: string | null = null;
  private cursor = 0;
  private running = false;
  private retryAt = 0;
  constructor(private inbox: Mailbox, private thread: () => string | undefined,
    private canDeliver: () => boolean, private queue = queueCodex) {}

  async tick() {
    const thread = this.thread();
    if (!this.enabled || !thread || !this.canDeliver() || this.running || Date.now() < this.retryAt) return;
    this.running = true;
    try {
      const result = await this.inbox.wait(this.cursor, 1);
      if (!result.message || !this.enabled || !this.canDeliver()) return;
      // Coalesce everything currently unread into one notification.
      const cursor = this.inbox.cursor;
      await this.queue(thread);
      this.cursor = cursor;
      this.error = null;
    } catch (error) {
      this.error = `Codex notification failed: ${String(error)}`;
      this.retryAt = Date.now() + 10_000;
    } finally { this.running = false; }
  }
}
