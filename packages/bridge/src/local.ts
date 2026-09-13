/**
 * Local IPC between the hook handler (short-lived, runs every tool round) and
 * the MCP process (long-lived, owns the WebSocket). Unix socket, one JSON
 * line per request/response. Hooks never touch the network.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DIRS, ensureDirs } from './config';

export interface SockMeta {
  pid: number;
  ppid: number;
  cwd: string;
  startedAt: number;
  sessionId?: string;
  /** Claude exports this non-secret address to its children. Never store the token. */
  messagingSocket?: string;
  sock: string;
}

export interface WaitResult {
  message: { id: string; from: string; preview: string } | null;
  cursor: number;
  pending: number;
}

export type LocalRequest =
  | { op: 'control'; sessionId: string; action: 'join' | 'create' | 'leave' | 'on' | 'off' | 'dnd' | 'visible' | 'invisible'; room?: string; name?: string }
  | { op: 'info' }
  | { op: 'bind'; sessionId: string }
  | { op: 'status'; status: 'busy' | 'idle' | 'shell' }
  | { op: 'drain' }
  | { op: 'peek' }
  /** long-poll: resolves when a new message arrives (preview only, nothing consumed) or after timeoutMs */
  | { op: 'wait'; timeoutMs: number; after?: number };

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

/** Walk through shell wrappers without confusing sibling Claude sessions. */
export function parentPids(): number[] {
  const out = [process.ppid];
  try {
    const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], {
      encoding: 'utf8', timeout: 1000, maxBuffer: 1024 * 1024,
    });
    const parents = new Map(rows.trim().split('\n').map((row) => {
      const [pid, ppid] = row.trim().split(/\s+/).map(Number);
      return [pid!, ppid!] as const;
    }));
    while (out.length < 32) {
      const next = parents.get(out[out.length - 1]!);
      if (!next || next <= 1 || out.includes(next)) break;
      out.push(next);
    }
  } catch { /* direct parent still works without ps */ }
  return out.filter((pid) => pid > 1);
}

/** Exact session/socket first, then a shared parent. Never guess from cwd/time. */
export function findSessionBridge(cwd: string, sessionId?: string, parents = parentPids()): SockMeta | null {
  try { cwd = fs.realpathSync(cwd); } catch { /* deleted directory */ }
  const metas = listMeta();
  if (sessionId) {
    const bound = metas.filter((m) => m.sessionId === sessionId);
    if (bound.length) return bound.length === 1 ? bound[0]! : null;
  }
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (socket) {
    const exact = metas.filter((m) => m.messagingSocket === socket && (!sessionId || !m.sessionId || m.sessionId === sessionId));
    if (exact.length) return exact.length === 1 ? exact[0]! : null;
  }
  const eligible = metas.filter((m) => m.cwd === cwd && (!sessionId || !m.sessionId || m.sessionId === sessionId)
    && (!socket || !m.messagingSocket || m.messagingSocket === socket));
  for (const pid of parents) {
    const siblings = eligible.filter((m) => m.ppid === pid);
    if (siblings.length) return siblings.length === 1 ? siblings[0]! : null;
  }
  return null;
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
    console.error('[agent-room] local socket failed:', e.message);
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
