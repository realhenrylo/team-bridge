/**
 * `team-bridge monitor` — declared in plugin monitors.json, so Claude Code
 * starts it with every session. It long-polls this session's bridge process
 * and prints one line per incoming message; Claude Code delivers each stdout
 * line as a notification. It never consumes messages — team_read_messages or
 * a hook reads the full text. A cursor also covers mail that predates the watch.
 */
import { findProjectConfig } from './config';
import { findSessionBridge, localRequest, parentPids, type SockMeta, type WaitResult } from './local';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runMonitor() {
  const cwd = process.cwd();
  const parents = parentPids();
  let meta: SockMeta | null = null;
  let cursor = 0;
  let bridgePid: number | undefined;

  for (;;) {
    if (!findProjectConfig(cwd)) { await sleep(3000); continue; }
    if (!meta) {
      meta = findSessionBridge(cwd, undefined, parents);
      if (!meta) { await sleep(1000); continue; }
      if (bridgePid !== meta.pid) { cursor = 0; bridgePid = meta.pid; }
    }
    const r = await localRequest<WaitResult>(
      meta.sock, { op: 'wait', after: cursor, timeoutMs: 55_000 }, 60_000,
    ).catch(() => null);
    if (r === null) {
      // Plugin reloads can replace the MCP process. Stay alive and rebind only to our session.
      meta = null;
      await sleep(1000);
      continue;
    }
    if (r.message) {
      const n = r.pending > 1 ? ` (${r.pending} unread)` : '';
      process.stdout.write(`team-bridge: new message from ${r.message.from}${n}: ${r.message.preview} — call team_read_messages now to read and handle pending messages. If already read through a hook, do not handle them twice.\n`);
      cursor = r.cursor ?? cursor;
    }
  }
}
