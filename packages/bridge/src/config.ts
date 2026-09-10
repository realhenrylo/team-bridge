import fs from 'node:fs';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/**
 * Persistent state lives in the plugin's data dir (`${CLAUDE_PLUGIN_DATA}`,
 * i.e. ~/.claude/plugins/data/<plugin-id>/): it survives plugin updates and
 * is removed on uninstall. TEAM_BRIDGE_HOME overrides it for dev/smoke runs;
 * the ~/.team-bridge fallback only applies when the CLI runs outside Claude.
 */
export const HOME =
  process.env.TEAM_BRIDGE_HOME ??
  process.env.CLAUDE_PLUGIN_DATA ??
  path.join(os.homedir(), '.team-bridge');
export const DIRS = {
  // unix socket paths are capped at ~104 bytes on macOS, so keep these short
  sock: path.join(os.tmpdir(), `team-bridge-${os.userInfo().uid}`),
  inbox: path.join(HOME, 'inbox'),
  sessions: path.join(HOME, 'conversations'),
  bindings: path.join(os.tmpdir(), `team-bridge-${os.userInfo().uid}`, 'bindings'),
};

export function ensureDirs() {
  for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
}

// ---- credentials -----------------------------------------------------------
// The hub is fixed; the display name comes from the plugin's `userConfig`
// (Claude Code prompts on enable and exports CLAUDE_PLUGIN_OPTION_*), falling
// back to the OS user name. TEAM_BRIDGE_HUB / credentials.json exist for
// self-hosters and for running the CLI outside Claude (smoke tests).

export const DEFAULT_HUB = 'wss://hub.agentroom.online';

export interface Credentials {
  hub: string; // wss://team-bridge-hub.<you>.workers.dev
  user: string;
  createToken?: string; // only needed to create rooms, if the hub requires it
}

const CRED_PATH = path.join(HOME, 'credentials.json');

export function readCredentials(): Credentials {
  const env = process.env;
  const file = readJson<Partial<Credentials>>(CRED_PATH) ?? {};
  const hub = env.CLAUDE_PLUGIN_OPTION_HUB || env.TEAM_BRIDGE_HUB || file.hub || DEFAULT_HUB;
  const user = env.CLAUDE_PLUGIN_OPTION_USER || file.user || os.userInfo().username;
  const createToken = env.CLAUDE_PLUGIN_OPTION_CREATE_TOKEN || file.createToken;
  return { hub: hub.replace(/^http/, 'ws'), user: normalizeUser(user), ...(createToken ? { createToken } : {}) };
}

export function normalizeUser(u: string) {
  return u.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'user';
}

export function writeCredentials(c: Credentials) {
  ensureDirs();
  fs.writeFileSync(CRED_PATH, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
}

// ---- one persistent record per host conversation -------------------------

export interface SessionState {
  sessionId: string; // Namespaced host ID: claude:<session_id> or codex:<threadId>.
  ref: string;
  room: string | null;
  enabled: boolean;
  dnd: boolean;
  visible: boolean;
}

export function sessionPath(id: string) {
  if (!id) throw new Error('Host session identity is required');
  return path.join(DIRS.sessions, `${createHash('sha256').update(id).digest('hex')}.json`);
}

export function openSession(id: string): SessionState {
  ensureDirs();
  const file = sessionPath(id);
  if (!fs.existsSync(file)) {
    const state: SessionState = { sessionId: id, ref: randomBytes(3).toString('hex'), room: null, enabled: true, dnd: false, visible: true };
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(state) + '\n', { mode: 0o600 });
      try { fs.linkSync(tmp, file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { fs.unlinkSync(tmp); }
  }
  const state = readJson<SessionState>(file);
  if (!state || state.sessionId !== id || !/^[0-9a-f]{6}$/.test(state.ref) ||
      !(state.room === null || typeof state.room === 'string' && state.room.length > 0) ||
      !['enabled', 'dnd', 'visible'].every(k => typeof state[k as keyof SessionState] === 'boolean')) {
    throw new Error(`Invalid session record: ${file}`);
  }
  return state;
}

/** The owning MCP process serializes mutations; CLI commands go through its IPC. */
export function saveSession(state: SessionState) {
  const file = sessionPath(state.sessionId);
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch { /* renamed */ } }
}

export function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}
