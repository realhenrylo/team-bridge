/**
 * `team-bridge room create [--name x]` | `room info <code>`
 * Rooms live on the hub; the code is the only thing a colleague needs to join.
 */
import { readCredentials } from './config';
import { httpRequest } from './net';

export interface RoomInfo {
  code: string;
  name: string;
  createdAt: number;
  lastActive: number;
  expiresAt: number;
  online: number;
}

function httpBase(): string {
  return readCredentials().hub.replace(/^ws/, 'http');
}

export async function createRoom(name: string): Promise<RoomInfo> {
  const res = await httpRequest(`${httpBase()}/rooms`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name }),
  });
  if (res.status !== 200) throw new Error(`create failed: ${res.status} ${res.text}`);
  return res.json<RoomInfo>();
}

export async function roomInfo(code: string): Promise<RoomInfo | null> {
  const res = await httpRequest(`${httpBase()}/rooms/${encodeURIComponent(code)}`);
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`lookup failed: ${res.status} ${res.text}`);
  return res.json<RoomInfo>();
}

export async function runRoom(args: string[]) {
  const positional = args.filter((a) => !a.startsWith('--'));
  const cmd = positional[0];
  const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };

  if (cmd === 'create') {
    const r = await createRoom(opt('name') ?? '');
    console.log(`room created: ${r.code}${r.name ? ` (${r.name})` : ''}`);
    console.log(`share the code; colleagues run \`/team join ${r.code}\` in their repo.`);
    const days = (r.expiresAt - r.lastActive) / 86_400_000;
    console.log(`expires after ${days < 1 ? 'less than a day' : `${Math.round(days)} days`} without activity.`);
    return;
  }
  if (cmd === 'info' && positional[1]) {
    const r = await roomInfo(positional[1]);
    if (!r) { console.log(`room ${positional[1]} does not exist or has expired`); process.exitCode = 1; return; }
    console.log(`${r.code}${r.name ? ` (${r.name})` : ''}: ${r.online} online, last active ${new Date(r.lastActive).toISOString()}, expires ${new Date(r.expiresAt).toISOString()}`);
    return;
  }
  console.error('usage: team-bridge room create [--name <name>] | room info <code>');
  process.exitCode = 1;
}
