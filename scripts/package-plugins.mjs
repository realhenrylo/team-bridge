import fs from 'node:fs';

const bundle = new URL('../packages/bridge/dist/agent-room.cjs', import.meta.url);
for (const host of ['claude', 'codex']) {
  const target = new URL(`../plugins/${host}/agent-room/dist/`, import.meta.url);
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(bundle, new URL('agent-room.cjs', target));
}
