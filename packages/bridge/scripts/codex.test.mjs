import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const plugin = path.resolve(import.meta.dirname, '../../../plugins/codex/team-bridge');
const launcher = path.join(plugin, 'scripts/mcp');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(50); } assert.fail('timed out'); }
const text = r => r.content.map(c => c.text ?? '').join('\n');

test('Codex metadata identity, opt-in queue, DND, resume, and isolation', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-codex-test-'));
  const queueLog = path.join(root, 'queue.jsonl');
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin/codex'), `#!/usr/bin/env node\nconst fs=require('fs'); if(fs.existsSync(${JSON.stringify(path.join(root,'fail'))}))process.exit(1); fs.appendFileSync(${JSON.stringify(queueLog)},JSON.stringify(process.argv.slice(2))+'\\n');`, { mode: 0o755 });
  const notifications = () => fs.existsSync(queueLog) ? fs.readFileSync(queueLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
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
  wss.on('connection', ws => ws.on('message', raw => {
    const m=JSON.parse(raw);
    if(m.type==='hello') { peers.set(m.ref, ws); ws.send(JSON.stringify({type:'welcome',name:`test-${m.ref}`,ref:m.ref,resumed:false,pending:[]})); }
  }));
  const clients=[];
  async function start(id) {
    const c = new Client({ name: 'codex-test', version: '1' });
    await c.connect(new StdioClientTransport({command:launcher,args:[],cwd:plugin,stderr:'pipe',env:{...process.env,PATH:`${root}/bin:${process.env.PATH}`,TEAM_BRIDGE_HOME:path.join(root,'data'),TEAM_BRIDGE_HUB:`ws://127.0.0.1:${wss.address().port}`}}));
    clients.push(c);
    return { c, call:(name,args={})=>c.callTool({name,arguments:name==='team_codex_event'||name==='team_control'?{cwd:root,...args}:args,_meta:{threadId:id}}).then(text) };
  }
  let seq=0;
  const send=(ref,body)=>peers.get(ref).send(JSON.stringify({type:'message',message:{id:`m${++seq}`,from:'claude-peer',fromRef:'abcdef',at:Date.now(),body}}));
  try {
    let a=await start('thread-a'); const b=await start('thread-b');
    assert.equal(peers.size,0,'never register a temporary identity');
    const missing=await a.c.callTool({name:'team_status',arguments:{}});
    assert.equal(missing.isError,true);
    assert.equal(peers.size,0);
    await a.call('team_codex_event',{event:'SessionStart'});
    await b.call('team_codex_event',{event:'SessionStart'});
    assert.match(await a.call('team_status'), /no room binding/);
    assert.match(await b.call('team_status'), /no room binding/);
    assert.equal(peers.size, 0, 'new conversations never autojoin');
    await a.call('team_control', { action: 'join', room: 'TEST-ROOM' });
    assert.match(await b.call('team_status'), /no room binding/, 'same workspace is independent');
    await b.call('team_control', { action: 'join', room: 'TEST-ROOM' });
    await a.call('team_control', { action: 'monitor-off' });
    await until(()=>peers.size===2);
    const status=await a.call('team_status');
    const ref=status.match(/\[([a-f0-9]{6})\]/)[1];
    const bref=(await b.call('team_status')).match(/\[([a-f0-9]{6})\]/)[1];
    assert.notEqual(ref,bref);
    assert.match(status,/listening: false/);
    const wrong=await a.c.callTool({name:'team_status',arguments:{},_meta:{threadId:'thread-b'}});
    assert.equal(wrong.isError,true,'cannot rebind another thread');
    send(ref,'before-on'); await sleep(650);
    assert.equal(notifications().length,0);
    await a.call('team_control',{action:'on'});
    await until(()=>notifications().length===1);
    assert.deepEqual(notifications()[0].slice(0,3),['queue','--thread','thread-a']);
    assert.ok(!notifications()[0].join(' ').includes('before-on'),'queue contains no remote content');
    assert.match(await a.call('team_read_messages'),/before-on/);
    await a.call('team_control',{action:'dnd'});
    send(ref,'during-dnd'); await sleep(650);
    assert.equal(notifications().length,1);
    await a.call('team_control',{action:'on'});
    await until(()=>notifications().length===2);
    assert.match(await a.call('team_codex_event',{event:'UserPromptSubmit'}),/during-dnd/);
    assert.match(await a.call('team_read_messages'),/No pending/);
    assert.match(await b.call('team_read_messages'),/No pending/);
    await a.call('team_control',{action:'monitor-off'});
    send(ref,'next-user-turn');await sleep(650);
    assert.equal(notifications().length,2);
    assert.match(await a.call('team_codex_event',{event:'Stop'}),/next-user-turn/);
    await a.call('team_control',{action:'off'});
    await a.c.close();
    peers.delete(ref);
    a=await start('thread-a');
    const resumed=await a.call('team_status');
    assert.ok(resumed.includes(`[${ref}]`));
    assert.match(resumed,/enabled: false/);
    assert.match(resumed,/listening: false/);
    assert.equal(peers.has(ref),false,'restore off before connecting');
    await a.call('team_control',{action:'on'});
    await until(()=>peers.has(ref));
    const fork=await start('thread-fork');
    assert.ok(!(await fork.call('team_status')).includes(`[${ref}]`));
    assert.match(await fork.call('team_status'), /no room binding/);
    assert.match(await a.call('team_status'), /room: TEST-ROOM/);
    const moved = path.join(root, 'new-workspace'); fs.mkdirSync(moved);
    await a.call('team_codex_event', { event: 'SessionStart', cwd: moved });
    assert.match(await a.call('team_status'), /room: TEST-ROOM/, 'cwd is display metadata only');
    await a.call('team_codex_event', { event: 'SessionStart', cwd: root });
    await until(async () => /connected: true/.test(await a.call('team_status')));
    // Notification failure must be visible, retain mail, and not crash the bridge.
    fs.writeFileSync(path.join(root,'fail'),'');
    send(ref,'failed-notification');
    await until(async()=>(await a.call('team_status')).includes('notification failed'));
    assert.match(await a.call('team_read_messages'),/failed-notification/);
    await a.call('team_control', { action: 'dnd' });
    send(ref, 'old-room-only');
    await until(async () => /queued unread: 1/.test(await a.call('team_status')));
    const failed = await a.c.callTool({ name: 'team_control', arguments: { action: 'join', room: 'MISSING', cwd: root }, _meta: { threadId: 'thread-a' } });
    assert.equal(failed.isError, true);
    assert.match(await a.call('team_status'), /room: TEST-ROOM/);
    await a.call('team_control', { action: 'create' });
    assert.match(await a.call('team_status'), /room: CREATED-ROOM/);
    assert.match(await b.call('team_status'), /room: TEST-ROOM/);
    assert.match(await a.call('team_read_messages'), /No pending/, 'old room inbox cleared');
    await a.call('team_control', { action: 'leave' });
    assert.match(await a.call('team_status'), /no room binding/);
    assert.match(await b.call('team_status'), /room: TEST-ROOM/);
    await a.c.close(); a = await start('thread-a');
    assert.match(await a.call('team_status'), /no room binding/, 'leave survives resume');
    assert.ok((await a.call('team_status')).includes(`[${ref}]`), 'leave preserves identity');
    await Promise.all([
      a.call('team_control', { action: 'join', room: 'TEST-ROOM' }),
      a.call('team_control', { action: 'leave' }),
    ]);
    assert.match(await a.call('team_status'), /no room binding/, 'concurrent controls commit in request order');
    assert.match(await b.call('team_status'), /room: TEST-ROOM/);


  } finally {
    await Promise.all(clients.map(c=>c.close()));
    for(const ws of wss.clients)ws.terminate();
    await new Promise(r=>wss.close(r));
    await new Promise(r=>http.close(r));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
