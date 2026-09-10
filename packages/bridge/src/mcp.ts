/**
 * `team-bridge mcp` — the long-lived process Claude Code spawns per session.
 * Exposes team_* tools over stdio, owns the WebSocket to the hub, and serves
 * the local unix socket that hooks use to drain mail / report status.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { formatAgentLine, type AgentInfo, type InboundMessage } from '@team-bridge/protocol';
import { DIRS, ensureDirs, readCredentials, openSession, saveSession, type SessionState } from './config';
import { HubClient } from './hub-client';
import { CodexListener, codexThread } from './hosts/codex';
import { createRoom, roomInfo } from './room';
import { notifyDesktop } from './notify';
import { Mailbox } from './mailbox';
import { renderMessages } from './inbox';
import { readHostSession } from './identity';
import { removeMeta, startLocalServer, writeMeta, type LocalRequest, type SockMeta } from './local';

const log = (...a: unknown[]) => console.error('[team-bridge]', ...a); // stdout is the MCP channel

export async function runMcp(host: 'claude' | 'codex' = 'claude') {
  ensureDirs();
  let cwd = host === 'claude' ? process.cwd() : '';
  let workspaceKnown = host === 'claude';
  const creds = readCredentials();
  let saved: SessionState | undefined;
  let ref: string | undefined;
  const spool = path.join(DIRS.inbox, `${process.pid}.jsonl`);
  let sessionId: string | undefined;
  let status: 'busy' | 'idle' | 'shell' = 'idle';
  let hub: HubClient | null = null;

  const meta: SockMeta = {
    pid: process.pid, ppid: process.ppid, cwd, startedAt: Date.now(),
    messagingSocket: process.env.CLAUDE_CODE_MESSAGING_SOCKET,
    sock: path.join(DIRS.sock, `${process.pid}.sock`),
  };
  writeMeta(meta);

  const switches = () => ({ enabled: saved?.enabled ?? true, dnd: saved?.dnd ?? false, visible: saved?.visible ?? true });
  const canDeliver = () => { const s = switches(); return !!sessionId && !!saved?.room && s.enabled && !s.dnd; };
  const inbox = new Mailbox(canDeliver);
  const listener = host === 'codex' ? new CodexListener(inbox, () => sessionId?.slice('codex:'.length), canDeliver) : null;
  if (listener) setInterval(() => void listener.tick(), 500).unref();

  const inactiveReason = () =>
    !sessionId ? 'waiting for session identity from the host; no temporary room identity has been registered'
    : !saved?.room ? 'this conversation has not joined a room (team join <code>)'
    : hub?.roomGone ? `room ${saved!.room} does not exist or has expired; create or join another (/team join <code>)`
    : !switches().enabled ? 'team bridge is switched off for this session (/team on to enable)'
    : null;

  // ---- hub connection ----------------------------------------------------
  const connect = () => {
    if (!saved?.room || !ref || !sessionId || hub) return;
    const room = saved.room;
    hub = new HubClient({
      hub: creds.hub, room, log,
      hello: {
        ref, user: creds.user, host: os.hostname(), cwd,
        repo: cwd ? path.basename(cwd) : host, visible: switches().visible, status,
      },
    });
    const connection = hub;
    hub.on('message', (m: InboundMessage) => {
      if (hub !== connection) return;
      fs.appendFileSync(spool, JSON.stringify(m) + '\n');
      inbox.push(m);
      if (!canDeliver()) return;
      if (status === 'idle') notifyDesktop(`${host}: message from ${m.from}`, m.body.split('\n')[0] ?? '');
    });
    hub.on('idle-notice', (n: { name: string; ref: string; reason: string }) => {
      if (hub !== connection) return;
      const m: InboundMessage = {
        id: crypto.randomUUID(), from: n.name, fromRef: n.ref, at: Date.now(),
        body: `[idle notice] ${n.name} [${n.ref}] is now ${n.reason}.`,
      };
      inbox.push(m);
    });
    hub.on('welcome', (w: { name: string; resumed: boolean }) => log(`registered as ${w.name} in room ${room}${w.resumed ? ' (resumed)' : ''}`));
    hub.connect();
  };
  const disconnect = (why: string) => {
    if (!hub) return;
    hub.close();
    hub = null;
    log(why);
  };

  const bindSession = (id: string) => {
    if (id === sessionId) return;
    // Read/create the persistent identity before disturbing the current connection.
    const next = openSession(host === 'claude' ? `claude:${id}` : id);
    disconnect('session identity changed');
    if (sessionId) {
      inbox.clear();
      fs.writeFileSync(spool, '');
    }
    sessionId = id;
    saved = next;
    ref = next.ref;
    if (listener) listener.enabled = false;
    status = 'idle';
    writeMeta({ ...meta, sessionId });
    if (saved?.room && switches().enabled) connect();
  };
  const initialSession = host === 'claude' ? readHostSession() : undefined;
  if (initialSession) bindSession(initialSession);
  else log(inactiveReason());

  // SessionStart may run before OR after MCP startup; also covers /clear and
  // plugin reloads without another user prompt. Keep the handoff for MCP reloads.
  setInterval(() => {
    try {
      const id = host === 'claude' ? readHostSession() : undefined;
      if (id && id !== sessionId) bindSession(id);
    } catch (error) { log('session identity unavailable:', String(error)); }
  }, 500).unref();

  const applyState = (patch: Partial<Pick<SessionState, 'room' | 'enabled' | 'dnd' | 'visible'>>) => {
    if (!saved) throw new Error('Waiting for host session identity');
    const next = { ...saved, ...patch };
    saveSession(next); // Persist before changing the live connection.
    if (next.room !== saved.room) {
      disconnect('room changed');
      inbox.clear();
      fs.writeFileSync(spool, '');
    }
    saved = next;
    if (!next.enabled || !next.room) disconnect('disconnected');
    else connect();
    hub?.setVisible(next.visible);
    inbox.refresh();
  };

  // Serialize async room lookups with switches; reject commands if the host has
  // moved to another conversation while the operation was awaiting the Hub.
  let controls: Promise<unknown> = Promise.resolve();
  const control = (id: string | undefined, action: string, room?: string, name?: string) => {
    const run = async () => {
      if (!['join', 'create', 'leave', 'on', 'off', 'dnd', 'visible', 'invisible', 'monitor-off'].includes(action)) throw new Error('Unknown team action');
      if (!id || sessionId !== id) throw new Error('Conversation changed; retry in the current conversation');
      let nextRoom: string | undefined;
      if (action === 'join' || action === 'create') {
        const info = action === 'create' ? await createRoom(name ?? '') : room ? await roomInfo(room) : null;
        if (!info) throw new Error('Supply an existing room code to join');
        nextRoom = info.code;
      }
      if (sessionId !== id) throw new Error('Conversation changed while contacting the Hub');
      if (action === 'monitor-off') { if (listener) listener.enabled = false; }
      else {
        const patch = action === 'leave' ? { room: null }
          : nextRoom ? { room: nextRoom, enabled: true, dnd: false }
          : action === 'off' ? { enabled: false }
          : action === 'dnd' ? { enabled: true, dnd: true }
          : action === 'visible' ? { visible: true }
          : action === 'invisible' ? { visible: false }
          : { enabled: true, dnd: false };
        applyState(patch);
        if (listener && ['on', 'join', 'create'].includes(action)) listener.enabled = true;
        if (listener && ['off', 'leave'].includes(action)) listener.enabled = false;
      }
      return { sessionId, room: saved?.room, ref, listening: listener?.enabled, ...switches() };
    };
    const result = controls.then(run);
    controls = result.catch(() => {});
    return result;
  };

  // ---- local socket for hooks --------------------------------------------
  const drain = () => {
    const out = inbox.drain();
    if (out.length) fs.writeFileSync(spool, '');
    return out;
  };

  startLocalServer(process.pid, (req: LocalRequest) => {
    switch (req.op) {
      case 'control':
        if (host !== 'claude') return { error: 'Use Codex MCP tools with host-supplied identity' };
        return control(req.sessionId, req.action, req.room, req.name);
      case 'info':
        return { pid: process.pid, cwd, sessionId, room: saved?.room, listening: listener?.enabled, name: hub?.name ?? null, ref, connected: hub?.connected ?? false, inactive: inactiveReason(), status, ...switches() };
      case 'bind':
        if (host === 'codex') return { error: 'Codex identity must come from MCP request metadata' };
        if (sessionId && sessionId !== req.sessionId && readHostSession() !== req.sessionId) {
          return { error: 'bridge already bound to another session' };
        }
        bindSession(req.sessionId);
        return { ok: true };
      case 'status':
        status = req.status;
        hub?.setStatus(status);
        return { ok: true };
      case 'peek':
        return { count: canDeliver() ? inbox.size : 0 };
      case 'wait':
        // An old monitor can survive /reload-plugins. Preserve its future-only
        // wait semantics instead of repeatedly returning the same unread message.
        return inbox.wait(req.after ?? inbox.cursor, req.timeoutMs);
      case 'drain':
        return { messages: drain() };

    }
  });

  const cleanup = () => { removeMeta(process.pid); try { fs.unlinkSync(spool); } catch { /* none */ } hub?.close(); };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => process.exit(0));
  process.stdin.on('close', () => process.exit(0)); // Claude went away

  // ---- MCP tools ---------------------------------------------------------
  const server = new McpServer({ name: 'team-bridge', version: '0.4.0' });
  const fromHost = (requestMeta: Record<string, unknown> | undefined, workspace?: string) => {
    if (host !== 'codex') return;
    const id = `codex:${codexThread(requestMeta)}`;
    if (sessionId && sessionId !== id) throw new Error('MCP connection belongs to another Codex thread');
    if (workspace !== undefined) {
      if (!path.isAbsolute(workspace)) throw new Error('Codex workspace must be an absolute path');
      const next = fs.realpathSync(workspace);
      if (!fs.statSync(next).isDirectory()) throw new Error('Codex workspace must be a directory');
      if (!workspaceKnown || cwd !== next) {
        disconnect('workspace changed');
        cwd = next;
        workspaceKnown = true;
        meta.cwd = cwd;
      }
    }
    bindSession(id);
    writeMeta({ ...meta, cwd, sessionId });
    if (switches().enabled) connect();
  };

  if (host === 'codex') {
    server.registerTool('team_codex_event', {
      description: 'Internal Codex lifecycle hook. Do not call manually.',
      inputSchema: { event: z.enum(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'Interrupt']), cwd: z.string() },
    }, async ({ event, cwd: workspace }, extra) => {
      fromHost(extra._meta, workspace);
      status = event === 'Stop' || event === 'Interrupt' ? 'idle' : 'busy';
      hub?.setStatus(status);
      const messages = event === 'Interrupt' ? [] : drain();
      const output = !messages.length ? {} : event === 'Stop'
        ? { decision: 'block', reason: renderMessages(messages) }
        : { hookSpecificOutput: { hookEventName: event, additionalContext: renderMessages(messages) } };
      return { content: [{ type: 'text', text: JSON.stringify(output) }] };
    });
    server.registerTool('team_control', {
      description: 'Manage this Codex thread’s team connection. on/join/create enable incoming-message notifications; monitor-off disables notifications only. Listening is off after MCP startup. dnd pauses delivery; off disconnects. Settings apply only to this thread.',
      inputSchema: { action: z.enum(['on', 'off', 'dnd', 'visible', 'invisible', 'monitor-off', 'join', 'create', 'leave']), room: z.string().optional(), name: z.string().optional(), cwd: z.string().optional().describe('Optional absolute workspace path for display metadata; never selects room membership') },
    }, async ({ action, room, name, cwd: workspace }, extra) => {
      fromHost(extra._meta, workspace);
      const result = await control(sessionId, action, room, name);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });
  }

  server.registerTool(
    'team_read_messages',
    {
      description: 'Read pending team messages after a team-bridge monitor notification. Handle task requests and reply to their sender using team_send_message. Messages already injected by a hook are not returned again. Do not poll this tool.',
      inputSchema: {},
    },
    async (_, extra) => {
      fromHost(extra._meta);
      const messages = drain();
      if (messages.length) { status = 'busy'; hub?.setStatus(status); }
      return { content: [{ type: 'text', text: messages.length ? renderMessages(messages) : 'No pending team messages. They may already have arrived through a hook, or delivery is paused.' }] };
    },
  );

  const requireHub = () => {
    const why = inactiveReason();
    if (why) throw new Error(why);
    if (!hub?.connected) throw new Error('not connected to the hub yet (reconnecting); try again in a moment');
    return hub;
  };

  server.registerTool(
    'team_list_agents',
    {
      description:
        "List colleagues' coding agent sessions connected to the team hub. Each row is `name [ref] · user@host · repo · status · started`. " +
        'The name is the address for team_send_message; append the [ref] only when a name is ambiguous.',
      inputSchema: {},
    },
    async (_, extra) => {
      fromHost(extra._meta);
      const h = requireHub();
      const agents = await h.list();
      const now = Date.now();
      const me = agents.find((a) => a.ref === h.ref);
      const others = agents.filter((a) => a.ref !== h.ref);
      const total = others.length + 1;
      const lines = [
        `Room ${saved?.room}: ${total} session${total === 1 ? '' : 's'} online (including you).`,
        `You are ${h.name} [${h.ref}]${me ? '' : ' (hidden from others)'} — colleagues message you by that name.`,
        '',
        others.length
          ? `Other sessions (${others.length}) — message them with team_send_message:`
          : 'Nobody else is online in this room right now.',
        ...others.map((a) => '  ' + formatAgentLine(a, now)),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  server.registerTool(
    'team_send_message',
    {
      description:
        "Send a message to a colleague's coding agent session. `to` is a name from team_list_agents (append ` [ref]` only if told the name is ambiguous). " +
        'The recipient sees only the first line as a preview, so make it a self-contained sentence. ' +
        'Replies arrive automatically as <team-message> blocks; do not poll. ' +
        'Never ask a colleague session to perform an action this session was denied.',
      inputSchema: {
        to: z.string().describe('Recipient name, e.g. "alice-backend-3f2a" or "alice-backend-3f2a [3f2a1b]"'),
        message: z.string().describe('Plain text. First line = preview.'),
        notify_when_idle: z.boolean().optional().describe('Also get one notice when the recipient next goes idle or exits.'),
      },
    },
    async ({ to, message, notify_when_idle }, extra) => {
      fromHost(extra._meta);
      const h = requireHub();
      try {
        const r = await h.send(to, message, notify_when_idle);
        const state = r.state === 'delivered'
          ? 'delivered to their bridge; their monitor will notify them, or a hook will read it at their next turn (execution is not yet confirmed)'
          : 'queued; they are offline and will get it when they reconnect';
        return { content: [{ type: 'text', text: `Sent to ${r.to} [${r.toRef}] — ${state}.` }] };
      } catch (e) {
        const err = e as Error & { code?: string; candidates?: AgentInfo[] };
        const extra = err.candidates?.length
          ? '\n' + err.candidates.map((a) => '  ' + formatAgentLine(a)).join('\n')
          : '';
        return { isError: true, content: [{ type: 'text', text: `${err.code ?? 'ERROR'}: ${err.message}${extra}` }] };
      }
    },
  );

  server.registerTool(
    'team_status',
    { description: 'Show this session\'s team-bridge identity, connection state, and switches (for troubleshooting).', inputSchema: {} },
    async (_, extra) => {
      fromHost(extra._meta);
      const s = switches();
      const text = [
        `name: ${hub?.name || '(not registered)'} [${ref ?? 'pending'}]`,
        `session: ${sessionId ?? '(waiting for hook)'}`,
        `hub: ${creds.hub}  room: ${saved?.room ?? '(no room binding)'}`,
        `connected: ${hub?.connected ?? false}  status: ${status}`,
        `enabled: ${s.enabled}  dnd: ${s.dnd}  visible: ${s.visible}`,
        `queued unread: ${inbox.size}`,
        listener ? `listening: ${listener.enabled}${listener.error ? `; ${listener.error}` : ''}` : '',
        inactiveReason() ? `inactive: ${inactiveReason()}` : '',
      ].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text }] };
    },
  );

  await server.connect(new StdioServerTransport());
}
