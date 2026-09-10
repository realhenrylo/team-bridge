import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

test('private project bindings, leave, and canonical paths', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-projects-')));
  const previous = process.env.TEAM_BRIDGE_HOME;
  process.env.TEAM_BRIDGE_HOME = path.join(root, 'data');
  try {
    const source = fs.readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const config = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
    const repo = path.join(root, 'repo');
    const other = path.join(root, 'other');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.mkdirSync(other);
    config.writeProjectConfig(repo, 'FIRST-ROOM');
    assert.deepEqual(fs.readdirSync(repo), ['src'], 'join never writes in the project');
    assert.equal(config.findProjectConfig(path.join(repo, 'src')).room, 'FIRST-ROOM');
    assert.equal(config.findProjectConfig(other), null);
    const alias = path.join(root, 'alias');
    fs.symlinkSync(repo, alias);
    assert.equal(config.projectConfigPath(alias), config.projectConfigPath(repo));
    config.writeProjectConfig(alias, 'NEXT-ROOM');
    assert.equal(config.findProjectConfig(repo).room, 'NEXT-ROOM');
    assert.equal(fs.statSync(config.projectConfigPath(repo)).mode & 0o777, 0o600);
    config.writeProjectConfig(other, 'OTHER-ROOM');
    assert.equal(config.findProjectConfig(other).room, 'OTHER-ROOM');
    assert.equal(config.findProjectConfig(repo).room, 'NEXT-ROOM');
    config.leaveProjectConfig(other);
    assert.equal(config.findProjectConfig(other), null);
    assert.equal(fs.existsSync(config.projectConfigPath(other)), false, 'leave deletes the binding');
    config.leaveProjectConfig(other); // Idempotent cleanup.
    assert.deepEqual(fs.readdirSync(other), [], 'binding lifecycle never modifies the repo');
    config.writeProjectConfig(other, 'REJOINED');
    assert.equal(config.findProjectConfig(other).room, 'REJOINED');
  } finally {
    if (previous === undefined) delete process.env.TEAM_BRIDGE_HOME;
    else process.env.TEAM_BRIDGE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
