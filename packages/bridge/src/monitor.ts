/**
 * `team-bridge monitor` — declared in plugin monitors.json, so Claude Code
 * starts it with every session. It long-polls this session's bridge process
 * and prints one line per incoming message; Claude Code delivers each stdout
 * line as a notification. It never consumes messages — the hooks still drain
 * the full text into the conversation — it only makes an idle session notice.
 */
import { findProjectConfig } from './config';
import { listMeta, localRequest, type SockMeta } from './local';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runMonitor() {
  const cwd = process.cwd();
  if (!findProjectConfig(cwd)) return; // not in a room: exit quietly, nothing to watch
  const startedAt = Date.now();

  let meta: SockMeta | null = null;
  for (;;) {
    meta = pick(cwd, startedAt);
    if (meta) break;
    if (Date.now() - startedAt > 60_000) return; // bridge never came up (plugin off?)
    await sleep(1000);
  }

  for (;;) {
    const r = await localRequest<{ message: { from: string; preview: string } | null; pending: number }>(
      meta.sock, { op: 'wait', timeoutMs: 55_000 }, 60_000,
    ).catch(() => null);
    if (r === null) {
      // bridge process gone: try to re-find it briefly, else exit
      const next = pick(cwd, Date.now());
      if (!next) return;
      meta = next;
      continue;
    }
    if (r.message) {
      const n = r.pending > 1 ? ` (${r.pending} unread)` : '';
      process.stdout.write(`team-bridge: new message from ${r.message.from}${n}: ${r.message.preview} — full text arrives at the next tool round or Stop; if this session is idle, start a turn to handle it.\n`);
    }
  }
}

/** Newest bridge process in this cwd started around the same time as us. */
function pick(cwd: string, around: number): SockMeta | null {
  return listMeta()
    .filter((m) => m.cwd === cwd && Math.abs(m.startedAt - around) < 120_000)
    .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}
