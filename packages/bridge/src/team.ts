/**
 * `team-bridge team <on|off|dnd|visible|invisible|status> [--global]`
 * Backs the /team slash command. Without --global it targets the bridge
 * process(es) running in the current directory, which apply the change
 * to their own session id; with --global it edits the top-level state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { findProjectConfig, PROJECT_FILE, readState, writeProjectConfig, writeState } from './config';
import { listMeta, localRequest } from './local';
import { createRoom, roomInfo } from './room';

export async function runTeam(args: string[]) {
  const global = args.includes('--global');
  const positional = args.filter((a) => !a.startsWith('--'));
  const cmd = positional[0] ?? 'status';
  const cwd = process.cwd();

  if (cmd === 'create') {
    const i = args.indexOf('--name');
    const r = await createRoom(i >= 0 ? args[i + 1] ?? '' : '');
    writeProjectConfig(cwd, r.code);
    console.log(`room created: ${r.code}${r.name ? ` (${r.name})` : ''}; this directory joined it (${path.join(cwd, PROJECT_FILE)}).`);
    console.log(`share the code — colleagues run \`/team join ${r.code}\` in their repo. This session connects within a few seconds.`);
    return;
  }
  if (cmd === 'join') {
    const code = positional[1];
    if (!code) { console.error('usage: /team join <room code>'); process.exitCode = 1; return; }
    const info = await roomInfo(code);
    if (!info) { console.error(`room ${code} does not exist or has expired`); process.exitCode = 1; return; }
    writeProjectConfig(cwd, info.code);
    console.log(`joined room ${info.code}${info.name ? ` (${info.name})` : ''}; wrote ${path.join(cwd, PROJECT_FILE)}. This session connects within a few seconds — no restart needed.`);
    return;
  }
  if (cmd === 'leave') {
    const cfg = findProjectConfig(cwd);
    if (!cfg) { console.log('this directory is not in a room'); return; }
    fs.unlinkSync(path.join(cfg.root, PROJECT_FILE));
    console.log(`left room ${cfg.room}; removed ${path.join(cfg.root, PROJECT_FILE)}`);
    return;
  }

  const patch: Record<string, boolean> | null =
    cmd === 'on' ? { enabled: true, dnd: false }
    : cmd === 'off' ? { enabled: false }
    : cmd === 'dnd' ? { enabled: true, dnd: true }
    : cmd === 'visible' ? { visible: true }
    : cmd === 'invisible' ? { visible: false }
    : null;

  if (cmd === 'status') {
    const state = readState();
    console.log(`global: enabled=${state.enabled} dnd=${state.dnd} visible=${state.visible}`);
    for (const m of listMeta()) {
      const info = await localRequest(m.sock, { op: 'info' }).catch(() => null);
      if (!info) continue;
      const here = m.cwd === cwd ? ' (this directory)' : '';
      console.log(`- ${info.name ?? '(unregistered)'} [${info.ref}] ${m.cwd}${here}: connected=${info.connected} enabled=${info.enabled} dnd=${info.dnd} visible=${info.visible}${info.inactive ? ` — ${info.inactive}` : ''}`);
    }
    return;
  }
  if (!patch) {
    console.error(`unknown command "${cmd}"; use on | off | dnd | visible | invisible | status [--global] | create [--name x] | join <code> | leave`);
    process.exitCode = 1;
    return;
  }

  if (global) {
    const state = readState();
    Object.assign(state, patch);
    writeState(state);
    console.log(`global switches updated: ${JSON.stringify(patch)}`);
    return;
  }

  const targets = listMeta().filter((m) => m.cwd === cwd);
  if (!targets.length) {
    console.log(`no bridge process running in ${cwd}; use --global to change the default`);
    return;
  }
  for (const m of targets) {
    const r = await localRequest(m.sock, { op: 'set', patch }).catch((e) => ({ error: String(e) }));
    console.log(`${m.sessionId ? `session ${m.sessionId.slice(0, 8)}` : `pid ${m.pid}`}: ${JSON.stringify(r)}`);
  }
}
