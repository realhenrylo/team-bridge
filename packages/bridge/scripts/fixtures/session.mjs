// A separate host process per session, including a shell wrapper around monitors.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

let client, monitor;
const bin = process.env.TEST_BRIDGE_BIN;
async function start() {
  client = new Client({ name: 'delivery-test', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [bin, 'mcp'], cwd: process.cwd(), env: process.env, stderr: 'pipe',
  }));
}
async function stopMonitor() {
  if (!monitor || monitor.exitCode !== null) return;
  const exited = once(monitor, 'exit');
  process.kill(-monitor.pid, 'SIGTERM');
  await exited;
}
process.on('message', async ({ id, op, ...args }) => {
  try {
    let result;
    switch (op) {
      case 'start': await start(); break;
      case 'restart': await client.close(); await start(); break;
      case 'tool': result = await client.callTool(args); break;
      case 'legacyWait': {
        const dir = path.join(os.tmpdir(), `agent-room-${os.userInfo().uid}`);
        const meta = fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
          .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
          .find((meta) => meta.ppid === process.pid);
        result = await new Promise((resolve, reject) => {
          const socket = net.createConnection(meta.sock);
          let data = '';
          socket.on('connect', () => socket.write(JSON.stringify({ op: 'wait', timeoutMs: 100 }) + '\n'));
          socket.on('data', (chunk) => { data += chunk; });
          socket.on('end', () => resolve(JSON.parse(data)));
          socket.on('error', reject);
        });
        break;
      }
      case 'hook': result = execFileSync(process.execPath, [bin, 'hook', args.event], {
        input: JSON.stringify({ session_id: process.env.TEST_SESSION_ID, cwd: process.cwd(), tool_name: 'Read', ...args.input }),
        encoding: 'utf8', env: process.env,
      }); break;
      case 'switch': result = execFileSync(process.execPath, [bin, 'team', args.command, ...(args.args ?? [])], { encoding: 'utf8', env: process.env }); break;
      case 'monitor':
        monitor = spawn('/bin/sh', ['-c', '"$TEST_NODE" "$TEST_BRIDGE_BIN" monitor & wait'], {
          env: { ...process.env, TEST_NODE: process.execPath }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        monitor.stdout.on('data', (data) => process.send?.({ event: 'output', text: data.toString() }));
        break;
      case 'stop': await stopMonitor(); await client?.close(); break;
      default: throw new Error(`unknown operation ${op}`);
    }
    process.send?.({ id, result });
  } catch (error) { process.send?.({ id, error: error.stack }); }
});
process.on('disconnect', async () => { await stopMonitor(); await client?.close(); process.exit(); });
