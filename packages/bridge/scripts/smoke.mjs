// End-to-end smoke test against a local hub (`pnpm hub:dev -- --port 8799`).
// Usage: S=/tmp/tb-smoke node scripts/smoke.mjs   (HUB=ws://... to override)
// Mimics how Claude Code runs the plugin: state in CLAUDE_PLUGIN_DATA,
// credentials from CLAUDE_PLUGIN_OPTION_*. Creates a room, joins $S/repoA and
// $S/repoB, exercises the whole flow incl. the monitor process, then (with
// EXPIRY=1 and a tiny ROOM_IDLE_DAYS on the hub) waits for the room to die.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

import path from 'node:path';
import { spawn as spawnProc } from 'node:child_process';
const S = process.env.S ?? '/tmp/tb-smoke', R = process.env.R ?? path.resolve(import.meta.dirname, '../../..');
process.env.CLAUDE_PLUGIN_DATA = `${S}/plugin-data`;
if (process.env.HUB !== 'default') process.env.TEAM_BRIDGE_HUB = process.env.HUB ?? 'ws://localhost:8799'; // HUB=default -> built-in hub
process.env.CLAUDE_PLUGIN_OPTION_USER = 'Henry Lo';
delete process.env.TEAM_BRIDGE_HOME;
const bin = `${R}/plugins/claude/team-bridge/dist/team-bridge.cjs`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (res) => res.content.map((c) => c.text).join('\n');
const envFor = (cwd) => ({ ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: `${S}/${path.basename(cwd)}-host.sock` });

async function spawn(cwd) {
  const client = new Client({ name: 'smoke', version: '0' });
  await client.connect(new StdioClientTransport({ command: 'node', args: [bin, 'mcp'], cwd, env: envFor(cwd), stderr: 'pipe' }));
  return client;
}
function hook(event, cwd, session_id, extra = {}) {
  const input = JSON.stringify({ session_id, cwd, hook_event_name: event, ...extra });
  return execFileSync('node', [bin, 'hook', event], { input, cwd, env: envFor(cwd) }).toString();
}

import fs from 'node:fs';
for (const d of ['repoA', 'repoB']) fs.mkdirSync(`${S}/${d}`, { recursive: true });
console.log('--- room create + join');
const created = execFileSync('node', [bin, 'room', 'create', '--name', 'smoke'], { env: process.env }).toString();
console.log(created.trim());
const code = /room created: ([A-Z0-9-]+)/.exec(created)[1];
try {
  execFileSync('node', [bin, 'room', 'info', 'ZZZZ-ZZZZ'], { env: process.env, stdio: 'pipe' });
  console.log('bogus code was accepted — FAILED');
} catch (e) { console.log('bogus code ->', e.stdout.toString().trim(), '(exit', e.status + ')'); }

const A = await spawn(`${S}/repoA`);
let B = await spawn(`${S}/repoB`);
hook('SessionStart', `${S}/repoA`, 'sess-A');
hook('SessionStart', `${S}/repoB`, 'sess-B');
for (const d of ['repoA', 'repoB']) console.log(execFileSync('node', [bin, 'team', 'join', code], { cwd: `${S}/${d}`, env: envFor(`${S}/${d}`) }).toString().trim());
// wait until both have registered with the hub (slow links / proxies can take a few seconds)
async function untilConnected(c, label) {
  for (let i = 0; i < 40; i++) {
    const st = text(await c.callTool({ name: 'team_status', arguments: {} }));
    if (/connected: true/.test(st)) return;
    await sleep(500);
  }
  throw new Error(`${label} never connected to the hub`);
}
await Promise.all([untilConnected(A, 'A'), untilConnected(B, 'B')]);
await sleep(300);

console.log('--- A: team_list_agents');
const list = text(await A.callTool({ name: 'team_list_agents', arguments: {} }));
console.log(list);
const bName = list.split('\n').find((l) => l.includes('repob'))?.trim().split(' ')[0];
console.log('B name =', bName);

console.log('--- B: SessionStart hook (binds session id)');
console.log(hook('SessionStart', `${S}/repoB`, 'sess-B') || '(no output)');

console.log('--- B: start monitor process (as monitors.json would)');
const mon = spawnProc('node', [bin, 'monitor'], { cwd: `${S}/repoB`, env: envFor(`${S}/repoB`), stdio: ['ignore', 'pipe', 'inherit'] });
let monOut = '';
mon.stdout.on('data', (d) => { monOut += d.toString(); });
await sleep(1500);

console.log('--- A -> B send');
console.log(text(await A.callTool({ name: 'team_send_message', arguments: { to: bName, message: 'hello from A\nsecond line', notify_when_idle: true } })));
await sleep(500);

console.log('monitor printed:', JSON.stringify(monOut.trim()) || '(nothing) — FAILED');
console.log('--- B: PostToolUse hook should drain the message');
console.log(hook('PostToolUse', `${S}/repoB`, 'sess-B', { tool_name: 'Read' }));

console.log('--- B: Stop hook with empty inbox -> idle -> A gets idle-notice');
console.log(hook('Stop', `${S}/repoB`, 'sess-B') || '(no output, went idle)');
await sleep(500);
console.log(hook('PostToolUse', `${S}/repoA`, 'sess-A', { tool_name: 'Read' }));

console.log('--- A -> unknown name');
console.log(text(await A.callTool({ name: 'team_send_message', arguments: { to: 'nobody-here', message: 'x' } })));

console.log('--- B: /team dnd, then A sends, B drains nothing');
console.log(execFileSync('node', [bin, 'team', 'dnd'], { cwd: `${S}/repoB`, env: envFor(`${S}/repoB`) }).toString());
console.log(text(await A.callTool({ name: 'team_send_message', arguments: { to: bName, message: 'while dnd' } })));
await sleep(300);
console.log('drained under dnd:', JSON.stringify(hook('PostToolUse', `${S}/repoB`, 'sess-B', { tool_name: 'Read' })));
console.log(execFileSync('node', [bin, 'team', 'on'], { cwd: `${S}/repoB`, env: envFor(`${S}/repoB`) }).toString());
console.log('drained after on:', hook('Stop', `${S}/repoB`, 'sess-B').slice(0, 160), '...');

console.log('--- offline queue: kill B, A sends, B comes back');
await B.close();
await sleep(800);
console.log(text(await A.callTool({ name: 'team_send_message', arguments: { to: bName, message: 'queued while offline' } })));
B = await spawn(`${S}/repoB`);
await untilConnected(B, 'resumed B');
const resumedStatus = text(await B.callTool({ name: 'team_status', arguments: {} }));
assert.ok(resumedStatus.includes(`name: ${bName} [`), 'B keeps its name after restarting');
const offlineMail = text(await B.callTool({ name: 'team_read_messages', arguments: {} }));
assert.match(offlineMail, /queued while offline/);
console.log('resumed B kept its identity and received mail sent to its old name');
await B.close();

mon.kill();
console.log('--- team_status on A');
console.log(text(await A.callTool({ name: 'team_status', arguments: {} })));
await A.close();

if (process.env.EXPIRY === '1') {
  console.log('--- room expiry: nobody connected, waiting for the alarm (~65s)');
  const base = (process.env.TEAM_BRIDGE_HUB ?? 'wss://hub.agentroom.online').replace(/^ws/, 'http');
  const t0 = Date.now();
  for (;;) {
    const res = await fetch(`${base}/rooms/${code}`); // note: plain fetch ignores proxies; expiry check is for local hubs
    if (res.status === 404) { console.log(`room ${code} destroyed after ${Math.round((Date.now() - t0) / 1000)}s`); break; }
    if (Date.now() - t0 > 120_000) { console.log('room still alive after 120s — expiry FAILED'); process.exitCode = 1; break; }
    await sleep(5000);
  }
}
