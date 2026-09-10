import fs from 'node:fs';
const target = new URL('../plugins/team-bridge/dist/', import.meta.url);
fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(new URL('../plugin/dist/team-bridge.cjs', import.meta.url), new URL('team-bridge.cjs', target));
