#!/usr/bin/env node
import { runHook } from './hook';
import { runConfigure } from './configure';
import { runMcp } from './mcp';
import { runMonitor } from './monitor';
import { runRoom } from './room';
import { runTeam } from './team';

const [cmd, ...rest] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case 'mcp':
      return runMcp();
    case 'hook':
      return runHook(rest[0] ?? '');
    case 'team':
      return runTeam(rest);
    case 'configure':
      return runConfigure(rest);
    case 'room':
      return runRoom(rest);
    case 'monitor':
      return runMonitor();
    default:
      console.error('usage: team-bridge <mcp | hook <Event> | monitor | team <cmd> | room <create|info> | configure ...>');
      process.exitCode = 1;
  }
}

main().catch((e) => {
  // hooks must never break Claude's turn
  if (cmd === 'hook') process.exit(0);
  console.error(e);
  process.exit(1);
});
