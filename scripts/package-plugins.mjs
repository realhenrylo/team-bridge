import fs from 'node:fs';

const bundle = new URL('../packages/bridge/dist/team-bridge.cjs', import.meta.url);
for (const host of ['claude', 'codex']) {
  const target = new URL(`../plugins/${host}/team-bridge/dist/`, import.meta.url);
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(bundle, new URL('team-bridge.cjs', target));
}
