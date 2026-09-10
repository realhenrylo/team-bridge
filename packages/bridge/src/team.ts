/** Claude commands target the exact owning MCP process, never a directory. */
import { findSessionBridge, localRequest } from './local';

export async function runTeam(args: string[]) {
  if (args.includes('--global')) throw new Error('Settings are per conversation; --global is not supported');
  const action = args[0] ?? 'status';
  const target = findSessionBridge(process.cwd());
  if (!target?.sessionId) throw new Error('No bound bridge for this conversation. Run inside Claude after its session hook has initialized.');
  let result;
  if (action === 'status') result = await localRequest(target.sock, { op: 'info' });
  else {
    if (!['join', 'create', 'leave', 'on', 'off', 'dnd', 'visible', 'invisible'].includes(action)) {
      throw new Error('Use create | join <code> | leave | on | off | dnd | visible | invisible | status');
    }
    const i = args.indexOf('--name');
    result = await localRequest(target.sock, {
      op: 'control', sessionId: target.sessionId,
      action: action as 'join' | 'create' | 'leave' | 'on' | 'off' | 'dnd' | 'visible' | 'invisible',
      room: args[1], name: i >= 0 ? args[i + 1] : undefined,
    }, 30_000);
  }
  if (result?.error) throw new Error(result.error);
  console.log(JSON.stringify(result, null, 2));
}
