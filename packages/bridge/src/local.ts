/**
 * Local IPC between the hook handler (short-lived, runs every tool round) and
 * the MCP process (long-lived, owns the WebSocket). Unix socket, one JSON
 * line per request/response. Hooks never touch the network.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DIRS, ensureDirs } from './config';

export interface SockMeta {
  pid: number;
  ppid: number;
  cwd: string;
  startedAt: number;
  sessionId?: string;
  sock: string;
}

export type LocalRequest =
  | { op: 'info' }
  | { op: 'bind'; sessionId: string }
  | { op: 'status'; status: 'busy' | 'idle' | 'shell' }
  | { op: 'drain' }
  | { op: 'peek' }
  /** long-poll: resolves when a new message arrives (preview only, nothing consumed) or after timeoutMs */
  | { op: 'wait'; timeoutMs: number }
  | { op: 'set'; patch: { enabled?: boolean; dnd?: boolean; visible?: boolean } };

export function sockPath(pid: number) {
  return path.join(DIRS.sock, `${pid}.sock`);
}
export function metaPath(pid: number) {
  return path.join(DIRS.sock, `${pid}.json`);
}

export function writeMeta(meta: SockMeta) {
  fs.writeFileSync(metaPath(meta.pid), JSON.stringify(meta));
}

export function removeMeta(pid: number) {
  for (const p of [sockPath(pid), metaPath(pid)]) {
    try { fs.unlinkSync(p); } catch { /* gone */ }
  }
}

export function listMeta(): SockMeta[] {
  ensureDirs();
  const out: SockMeta[] = [];
  for (const f of fs.readdirSync(DIRS.sock)) {
    if (!f.endsWith('.json')) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(DIRS.sock, f), 'utf8')) as SockMeta;
      if (isAlive(m.pid)) out.push(m);
      else removeMeta(m.pid);
    } catch { /* partial write, skip */ }
  }
  return out;
}

export function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function startLocalServer(
  pid: number,
  handle: (req: LocalRequest) => Promise<unknown> | unknown,
): net.Server {
  ensureDirs();
  const p = sockPath(pid);
  try { fs.unlinkSync(p); } catch { /* fresh */ }
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', async (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let res: unknown;
      try {
        res = await handle(JSON.parse(line) as LocalRequest);
      } catch (e) {
        res = { error: String(e) };
      }
      conn.end(JSON.stringify(res ?? {}) + '\n');
    });
    conn.on('error', () => { /* client went away */ });
  });
  server.on('error', (e) => {
    console.error('[team-bridge] local socket failed:', e.message);
  });
  server.listen(p);
  return server;
}

export function localRequest<T = any>(sock: string, req: LocalRequest, timeoutMs = 1500): Promise<T> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sock);
    let buf = '';
    const timer = setTimeout(() => { conn.destroy(); reject(new Error('local timeout')); }, timeoutMs);
    conn.on('connect', () => conn.write(JSON.stringify(req) + '\n'));
    conn.on('data', (c) => { buf += c.toString(); });
    conn.on('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(buf.trim() || '{}')); } catch (e) { reject(e); }
    });
    conn.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
