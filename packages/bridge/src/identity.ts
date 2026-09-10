import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DIRS, HOME, ensureDirs, readJson } from './config';

const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/** Identify the host across its shell wrappers, but not across a host restart.
 * The process birth time prevents a recycled PID/socket path from restoring
 * another conversation's ID. No conversation is inferred from the directory.
 */
function hostKey(): string | null {
  try {
    const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart=,comm='], {
      encoding: 'utf8', timeout: 1000, maxBuffer: 2 * 1024 * 1024,
    });
    const processes = new Map(rows.trim().split('\n').map((line) => {
      const parts = line.trim().split(/\s+/);
      return [Number(parts[0]), { parent: Number(parts[1]), born: parts.slice(2, 7).join(' '), command: parts.slice(7).join(' ') }] as const;
    }));
    let pid = process.ppid;
    for (let i = 0; i < 32 && pid > 1; i++) {
      const parent = processes.get(pid);
      if (!parent) return null;
      if (!['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'env'].includes(path.basename(parent.command))) {
        return hash(JSON.stringify([path.resolve(HOME), pid, parent.born, process.env.CLAUDE_CODE_MESSAGING_SOCKET ?? '']));
      }
      pid = parent.parent;
    }
  } catch { /* The direct bind IPC remains available if process inspection fails. */ }
  return null;
}

let bindingFile: string | null | undefined;
function hostBindingFile() {
  if (bindingFile === undefined) {
    const key = hostKey();
    bindingFile = key ? path.join(DIRS.bindings, `${key}.json`) : null;
  }
  return bindingFile;
}

/** SessionStart writes this even if the MCP process or room does not exist yet. */
export function rememberHostSession(sessionId: string) {
  const file = hostBindingFile();
  if (!file) return;
  ensureDirs();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ sessionId }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch { /* renamed */ } }
}

export function readHostSession(): string | undefined {
  const file = hostBindingFile();
  const record = file ? readJson<{ sessionId?: string }>(file) : null;
  return typeof record?.sessionId === 'string' && record.sessionId ? record.sessionId : undefined;
}

export function forgetHostSession(sessionId: string) {
  const file = hostBindingFile();
  if (file && readHostSession() === sessionId) {
    try { fs.unlinkSync(file); } catch { /* already removed */ }
  }
}

/** Atomically create one persistent ref per Claude conversation, including forks. */
export function sessionRef(sessionId: string): string {
  ensureDirs();
  const file = path.join(DIRS.sessions, `${hash(sessionId)}.json`);
  const existing = () => {
    const record = readJson<{ sessionId: string; ref: string }>(file);
    if (record?.sessionId !== sessionId || !/^[0-9a-f]{6}$/.test(record.ref)) {
      throw new Error(`invalid saved session identity: ${file}`);
    }
    return record.ref;
  };
  if (fs.existsSync(file)) return existing();
  const ref = crypto.randomBytes(3).toString('hex');
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ sessionId, ref }) + '\n', { mode: 0o600 });
    try { fs.linkSync(tmp, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return existing();
  } finally { fs.unlinkSync(tmp); }
}
