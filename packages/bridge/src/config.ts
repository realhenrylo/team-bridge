import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
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
  sessions: path.join(HOME, 'sessions'),
  projects: path.join(HOME, 'projects'),
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

// ---- switches: edited by `/team ...` -------------------------------------

export interface SessionOverride {
  enabled?: boolean;
  dnd?: boolean;
  visible?: boolean;
}

export interface State {
  enabled: boolean;
  dnd: boolean; // stay listed, queue mail, but don't inject it into the conversation
  visible: boolean; // appear in other people's list
  acceptFrom: string[]; // ["*"] or user names
  sessions: Record<string, SessionOverride>;
}

const STATE_PATH = path.join(HOME, 'state.json');
const DEFAULT_STATE: State = { enabled: true, dnd: false, visible: true, acceptFrom: ['*'], sessions: {} };

export function readState(): State {
  return { ...DEFAULT_STATE, ...(readJson<Partial<State>>(STATE_PATH) ?? {}) };
}

export function writeState(s: State) {
  ensureDirs();
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n');
}

export function statePath() {
  return STATE_PATH;
}

/** Effective switches for one session (per-session override wins). */
export function effective(state: State, sessionId: string | undefined) {
  const o = (sessionId && state.sessions[sessionId]) || {};
  return {
    enabled: o.enabled ?? state.enabled,
    dnd: o.dnd ?? state.dnd,
    visible: o.visible ?? state.visible,
    acceptFrom: state.acceptFrom,
  };
}

// ---- project room bindings: private plugin data, keyed by canonical path ----

const LEGACY_PROJECT_FILE = '.team-bridge.json';

export interface ProjectConfig {
  room: string;
  root: string;
}

function canonicalProject(dir: string) {
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

export function projectConfigPath(dir: string) {
  const key = createHash('sha256').update(canonicalProject(dir)).digest('hex');
  return path.join(DIRS.projects, `${key}.json`);
}

function saveProject(dir: string, room: string | null) {
  ensureDirs();
  const root = canonicalProject(dir);
  const file = projectConfigPath(root);
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ root, room }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already renamed */ }
  }
}

export function findProjectConfig(cwd: string): ProjectConfig | null {
  let dir = canonicalProject(cwd);
  for (;;) {
    const cfg = readJson<{ room?: string | null }>(projectConfigPath(dir));
    if (cfg?.room === null) return null; // Explicit leave also blocks legacy re-import.
    if (typeof cfg?.room === 'string' && cfg.room) return { room: cfg.room, root: dir };
    const legacy = readJson<{ room?: string }>(path.join(dir, LEGACY_PROJECT_FILE));
    if (typeof legacy?.room === 'string' && legacy.room) {
      saveProject(dir, legacy.room);
      return { room: legacy.room, root: dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function writeProjectConfig(dir: string, room: string) {
  saveProject(dir, room);
}

export function leaveProjectConfig(dir: string) {
  saveProject(dir, null);
}

export function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}
