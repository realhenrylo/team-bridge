import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const bin = path.resolve(import.meta.dirname, '../../../plugins/claude/agent-room/dist/agent-room.cjs');
const fixture = path.join(import.meta.dirname, 'fixtures/session.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (result) => result.content.map((item) => item.text ?? '').join('\n');
async function until(check, description) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await sleep(50); }
  assert.fail(`Timed out: ${description}`);
}

function host(cwd, env) {
  const child = fork(fixture, [], { cwd, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let id = 0;
  const pending = new Map();
  const state = { output: '' };
  child.on('message', (message) => {
    if (message.event === 'output') { state.output += message.text; return; }
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id); clearTimeout(p.timer);
    if (message.error) p.reject(new Error(message.error)); else p.resolve(message.result);
  });
  const call = (op, args = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`host request timed out: ${op}`)); }, 10_000);
    pending.set(requestId, { resolve, reject, timer });
    child.send({ id: requestId, op, ...args });
  });
  return {
    state, call,
    tool: (name) => call('tool', { name, arguments: {} }).then(text),
    async close() {
      try { await call('stop'); } finally { child.disconnect(); }
      await once(child, 'exit');
    },
  };
}

for (const identity of ['messaging-address', 'parent-chain']) {
  test(`delivery isolation and recovery via ${identity}`, { timeout: 30_000 }, async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-delivery-')));
    const cwd = path.join(root, 'repo');
    fs.mkdirSync(cwd);
    const http = createServer((req, res) => {
      const code = req.method === 'POST' ? 'CREATED-ROOM' : decodeURIComponent(req.url.split('/').at(-1));
      if (code === 'MISSING') { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code, name: 'test' }));
    });
    const wss = new WebSocketServer({ server: http });
    http.listen(0, '127.0.0.1');
    await once(wss, 'listening');
    const peers = new Map();
    const hellos = [];
    const registered = new Map();
    const pending = new Map();
    wss.on('connection', (ws) => ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'hello') {
        hellos.push(m);
        peers.set(m.user, ws);
        const resumed = registered.has(m.ref);
        const name = registered.get(m.ref) ?? `${m.user}-${m.ref}`;
        registered.set(m.ref, name);
        ws.send(JSON.stringify({ type: 'welcome', name, ref: m.ref, resumed, pending: pending.get(m.ref) ?? [] }));
        pending.delete(m.ref);
      }
    }));
    let sequence = 0;
    function send(to, body) {
      peers.get(to).send(JSON.stringify({ type: 'message', message: {
        id: `test-${++sequence}`, from: 'sender', fromRef: 'abc123', body, at: Date.now(),
      } }));
    }
    const env = {
      ...process.env, TEST_BRIDGE_BIN: bin, AGENT_ROOM_HOME: path.join(root, 'data'),
      AGENT_ROOM_HUB: `ws://127.0.0.1:${wss.address().port}`,
    };
    delete env.CLAUDE_PLUGIN_OPTION_HUB;
    delete env.CLAUDE_CODE_MESSAGING_SOCKET;
    const sessionEnv = (name) => ({
      ...env, TEST_SESSION_ID: `${path.basename(root)}-${name}`, CLAUDE_PLUGIN_OPTION_USER: name,
      ...(identity === 'messaging-address' ? { CLAUDE_CODE_MESSAGING_SOCKET: `${root}/${name}.sock` } : {}),
    });
    let a = host(cwd, sessionEnv('a'));
    const b = host(cwd, sessionEnv('b'));
    try {
      // SessionStart before MCP exists; a later hook must bind the correct process.
      assert.equal(await a.call('hook', { event: 'SessionStart' }), '');
      await a.call('start'); await b.call('start');
      assert.match(await b.tool('agent_room_status'), /waiting for hook/);
      assert.ok(!hellos.some((hello) => hello.user === 'b'), 'no transient identity before the first hook');
      await b.call('hook', { event: 'UserPromptSubmit' });
      assert.match(await a.tool('agent_room_status'), /no room binding/);
      assert.match(await b.tool('agent_room_status'), /no room binding/);
      await a.call('switch', { command: 'join', args: ['TEST-ROOM'] });
      assert.match(await b.tool('agent_room_status'), /no room binding/, 'same cwd does not join B');
      await b.call('switch', { command: 'join', args: ['TEST-ROOM'] });
      await until(() => peers.has('a') && peers.has('b'), 'bridges connected');
      await a.call('hook', { event: 'UserPromptSubmit' });
      const originalRef = hellos.find((hello) => hello.user === 'a').ref;
      const originalName = registered.get(originalRef);
      assert.notEqual(originalRef, hellos.find((hello) => hello.user === 'b').ref);

      send('a', 'arrived-before-monitor\ncomplete body');
      await until(async () => /queued unread: 1/.test(await a.tool('agent_room_status')), 'message queued');
      assert.equal((await a.call('legacyWait')).message, null, 'old monitors must not spin on unread mail after reload');
      // Start A's monitor after B's bridge: cwd/time matching used to choose B.
      await a.call('monitor'); await b.call('monitor');
      await until(() => a.state.output.includes('arrived-before-monitor'), 'backlog notification');
      assert.equal(b.state.output, '');
      assert.match(await a.tool('agent_room_read_messages'), /complete body/);
      assert.match(await a.tool('agent_room_read_messages'), /No pending/);
      assert.equal(await a.call('hook', { event: 'PostToolUse' }), '');

      // A long poll must survive idle time, notify only once, and never cross sessions.
      send('b', 'only-b');
      await until(() => b.state.output.includes('only-b'), 'live notification');
      assert.ok(!a.state.output.includes('only-b'));
      assert.match(await b.call('hook', { event: 'PostToolUse' }), /only-b/);
      assert.match(await b.tool('agent_room_read_messages'), /No pending/);

      await a.call('switch', { command: 'dnd' });
      assert.match(await a.tool('agent_room_status'), /dnd: true/);
      assert.match(await b.tool('agent_room_status'), /dnd: false/);
      send('a', 'during-dnd');
      await until(async () => /queued unread: 1/.test(await a.tool('agent_room_status')), 'DND queue');
      assert.match(await a.tool('agent_room_read_messages'), /No pending/);
      assert.ok(!a.state.output.includes('during-dnd'));
      await a.call('switch', { command: 'on' });
      await until(() => a.state.output.includes('during-dnd'), 'DND resume wake');
      assert.match(await a.tool('agent_room_read_messages'), /during-dnd/);

      // Keep the monitor alive across replacement of its MCP process.
      peers.delete('a');
      await a.call('restart');
      await until(() => peers.has('a'), 'replacement bridge connected');
      assert.equal(hellos.filter((hello) => hello.user === 'a').at(-1).ref, originalRef, 'MCP reload keeps ref without another hook');
      await a.call('hook', { event: 'UserPromptSubmit' });
      send('a', 'after-restart');
      await until(() => a.state.output.includes('after-restart'), 'monitor reattached');
      assert.match(await a.tool('agent_room_read_messages'), /after-restart/);
      assert.ok(!b.state.output.includes('after-restart'));
      await sleep(150);
      for (const message of ['arrived-before-monitor', 'during-dnd', 'after-restart']) {
        assert.equal(a.state.output.split(message).length - 1, 1, `exactly one notification: ${message}`);
      }

      // Exit the entire host, then resume the SAME conversation under a new
      // host PID/socket. A message addressed to the old ref must come back.
      await a.call('switch', { command: 'dnd' });
      await a.call('hook', { event: 'SessionEnd' });
      await a.close();
      pending.set(originalRef, [{ id: 'offline-message', from: 'sender', fromRef: 'abc123', body: 'queued-for-old-ref', at: Date.now() }]);
      peers.delete('a');
      const resumedEnv = { ...sessionEnv('a') };
      if (identity === 'messaging-address') resumedEnv.CLAUDE_CODE_MESSAGING_SOCKET = `${root}/a-resumed.sock`;
      a = host(cwd, resumedEnv);
      await a.call('hook', { event: 'SessionStart' });
      await a.call('start');
      await until(() => peers.has('a'), 'resumed conversation connected');
      assert.equal(hellos.filter((hello) => hello.user === 'a').at(-1).ref, originalRef);
      await until(async () => (await a.tool('agent_room_status')).includes(`name: ${originalName}`), 'same name after resume');
      assert.match(await a.tool('agent_room_status'), /dnd: true/, 'per-session switches restored before reconnect');
      assert.match(await a.tool('agent_room_read_messages'), /No pending/);
      await a.call('switch', { command: 'on' });
      assert.match(await a.tool('agent_room_read_messages'), /queued-for-old-ref/);

      // /clear or changing the active conversation in the same host uses a
      // distinct identity and never inherits the previous conversation's mail.
      send('a', 'belongs-to-old-conversation');
      await until(async () => /queued unread: 1/.test(await a.tool('agent_room_status')), 'old conversation inbox');
      await a.call('switch', { command: 'join', args: ['OTHER-ROOM'] });
      assert.match(await a.tool('agent_room_status'), /room: OTHER-ROOM/);
      assert.match(await b.tool('agent_room_status'), /room: TEST-ROOM/);
      assert.match(await a.tool('agent_room_read_messages'), /No pending/);
      await a.call('switch', { command: 'leave' });
      assert.match(await a.tool('agent_room_status'), /no room binding/);
      assert.match(await b.tool('agent_room_status'), /room: TEST-ROOM/);
      await a.call('restart');
      assert.match(await a.tool('agent_room_status'), /no room binding/);
      assert.ok((await a.tool('agent_room_status')).includes(`[${originalRef}]`));
      const count = hellos.length;
      await a.call('hook', { event: 'SessionStart', input: { session_id: `${path.basename(root)}-fork` } });
      await until(async () => (await a.tool('agent_room_status')).includes(`${path.basename(root)}-fork`), 'fork bound');
      assert.equal(hellos.length, count, 'fork does not connect automatically');
      assert.match(await a.tool('agent_room_status'), /no room binding/);
      assert.ok(!(await a.tool('agent_room_status')).includes(`[${originalRef}]`));
      assert.match(await a.tool('agent_room_read_messages'), /No pending/);
    } finally {
      await Promise.all([a.close(), b.close()]);
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => http.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
