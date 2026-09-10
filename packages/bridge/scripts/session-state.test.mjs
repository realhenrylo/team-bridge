import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

test('per-conversation state, host isolation, persistence, and atomic storage', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-projects-')));
  const previous = process.env.TEAM_BRIDGE_HOME;
  process.env.TEAM_BRIDGE_HOME = path.join(root, 'data');
  try {
    const source = fs.readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const config = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
    const a = config.openSession('claude:same-id');
    const b = config.openSession('codex:same-id');
    assert.equal(a.room, null);
    assert.equal(b.room, null);
    assert.notEqual(config.sessionPath(a.sessionId), config.sessionPath(b.sessionId));
    config.saveSession({ ...a, room: 'FIRST-ROOM', dnd: true, visible: false });
    const resumed = config.openSession(a.sessionId);
    assert.equal(resumed.ref, a.ref);
    assert.equal(resumed.room, 'FIRST-ROOM');
    assert.equal(resumed.dnd, true);
    assert.equal(resumed.visible, false);
    assert.equal(config.openSession(b.sessionId).room, null);
    assert.equal(config.openSession('claude:fork').room, null);
    config.saveSession({ ...resumed, room: null });
    assert.equal(config.openSession(a.sessionId).room, null);
    assert.equal(config.openSession(a.sessionId).ref, a.ref);
    assert.equal(fs.statSync(config.sessionPath(a.sessionId)).mode & 0o777, 0o600);
    assert.ok(fs.readdirSync(path.join(root, 'data', 'conversations')).every(f => f.endsWith('.json')));
    fs.writeFileSync(config.sessionPath(b.sessionId), '{}');
    assert.throws(() => config.openSession(b.sessionId), /Invalid session record/);

  } finally {
    if (previous === undefined) delete process.env.TEAM_BRIDGE_HOME;
    else process.env.TEAM_BRIDGE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
