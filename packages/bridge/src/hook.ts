/**
 * `team-bridge hook <Event>` — runs on Claude Code hook events. Reads the
 * event JSON on stdin, finds this session's bridge process via its unix
 * socket, and either drains mail into the conversation or reports status.
 * Must be fast and must never fail loudly: any problem -> exit 0 silently.
 */
import fs from 'node:fs';
import { effective, findProjectConfig, readState } from './config';
import { renderMessages } from './inbox';
import { findSessionBridge, localRequest } from './local';

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name?: string;
  stop_hook_active?: boolean;
}

export async function runHook(event: string) {
  const input = readInput();
  if (!input) return;
  const cwd = input.cwd || process.cwd();
  if (!findProjectConfig(cwd)) return; // project not opted in — cheapest possible exit
  const sw = effective(readState(), input.session_id);
  if (!sw.enabled) return;

  const meta = findSessionBridge(cwd, input.session_id);
  if (!meta) return;
  const call = <T = any>(req: Parameters<typeof localRequest>[1]) => localRequest<T>(meta.sock, req).catch(() => null);
  // SessionStart can run before the MCP server exists. Bind on the first later hook too.
  if (!meta.sessionId) {
    const bound = await call<{ ok?: boolean }>({ op: 'bind', sessionId: input.session_id });
    if (!bound?.ok) return;
  }

  switch (event) {
    case 'SessionStart': {
      await call({ op: 'status', status: 'busy' });
      const info = await call<{ name: string | null; inactive: string | null }>({ op: 'info' });
      const r = await call<{ messages: any[] }>({ op: 'drain' });
      const parts: string[] = [];
      if (info?.name) parts.push(`team-bridge: this session is ${info.name}. Colleagues' messages arrive as <team-message> blocks; use team_list_agents / team_send_message to reach them.`);
      if (r?.messages?.length) parts.push(renderMessages(r.messages));
      if (parts.length) emitContext('SessionStart', parts.join('\n\n'));
      return;
    }
    case 'UserPromptSubmit': {
      await call({ op: 'status', status: 'busy' });
      const r = await call<{ messages: any[] }>({ op: 'drain' });
      if (r?.messages?.length) emitContext('UserPromptSubmit', renderMessages(r.messages));
      return;
    }
    case 'PreToolUse': {
      if (input.tool_name === 'Bash') await call({ op: 'status', status: 'shell' });
      return;
    }
    case 'PostToolUse': {
      if (input.tool_name === 'Bash') await call({ op: 'status', status: 'busy' });
      const r = await call<{ messages: any[] }>({ op: 'drain' });
      if (r?.messages?.length) emitContext('PostToolUse', renderMessages(r.messages));
      return;
    }
    case 'Stop': {
      const r = await call<{ messages: any[] }>({ op: 'drain' });
      if (r?.messages?.length) {
        // keep Claude going so it can handle the mail before going idle
        process.stdout.write(JSON.stringify({ decision: 'block', reason: renderMessages(r.messages) }) + '\n');
        return;
      }
      await call({ op: 'status', status: 'idle' });
      return;
    }
    case 'SessionEnd': {
      await call({ op: 'status', status: 'idle' });
      return;
    }
  }
}

function emitContext(hookEventName: string, additionalContext: string) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }) + '\n');
}

function readInput(): HookInput | null {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? (JSON.parse(raw) as HookInput) : null;
  } catch {
    return null;
  }
}
