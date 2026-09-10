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
import { DIRS, effective, ensureDirs, findProjectConfig, readCredentials, readState, statePath, writeState } from './config';
import { HubClient } from './hub-client';
import { notifyDesktop } from './notify';
import { Mailbox } from './mailbox';
import { renderMessages } from './inbox';
import { readHostSession, sessionRef } from './identity';
import { removeMeta, startLocalServer, writeMeta, type LocalRequest, type SockMeta } from './local';

const log = (...a: unknown[]) => console.error('[team-bridge]', ...a); // stdout is the MCP channel

export async function runMcp() {
  ensureDirs();
  const cwd = process.cwd();
  const creds = readCredentials();
  let project = findProjectConfig(cwd);
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

  const switches = () => effective(readState(), sessionId);
  const canDeliver = () => { const s = switches(); return !!sessionId && !!project && s.enabled && !s.dnd; };
  const inbox = new Mailbox(canDeliver);

  const inactiveReason = () =>
    !project ? 'this project has no .team-bridge.json, so it is not in any room (/team join <code>)'
    : !sessionId ? 'waiting for Claude session identity from a hook; no temporary room identity has been registered'
    : hub?.roomGone ? `room ${project.room} does not exist or has expired; create or join another (/team join <code>)`
    : !switches().enabled ? 'team bridge is switched off for this session (/team on to enable)'
    : null;

  // ---- hub connection ----------------------------------------------------
  // `/team join` / `/team create` write .team-bridge.json while this process
  // is already running, so watch for it instead of demanding a restart; and
  // drop the connection if `/team leave` removes it.
  const connect = () => {
    if (!project || !ref || !sessionId || hub) return;
    const room = project.room;
    hub = new HubClient({
      hub: creds.hub, room, log,
      hello: {
        ref, user: creds.user, host: os.hostname(), cwd,
        repo: path.basename(project.root), visible: switches().visible, status,
      },
    });
    const connection = hub;
    hub.on('message', (m: InboundMessage) => {
      if (hub !== connection) return;
      fs.appendFileSync(spool, JSON.stringify(m) + '\n');
      inbox.push(m);
      if (!canDeliver()) return;
      if (status === 'idle') notifyDesktop(`Claude: message from ${m.from}`, m.body.split('\n')[0] ?? '');
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
    const nextRef = sessionRef(id);
    disconnect('session identity changed');
    if (sessionId) {
      inbox.clear();
      fs.writeFileSync(spool, '');
    }
    sessionId = id;
    ref = nextRef;
    status = 'idle';
    writeMeta({ ...meta, sessionId });
    if (project && switches().enabled) connect();
  };
  const initialSession = readHostSession();
  if (initialSession) bindSession(initialSession);
  else log(inactiveReason());

  // SessionStart may run before OR after MCP startup; also covers /clear and
  // plugin reloads without another user prompt. Keep the handoff for MCP reloads.
  setInterval(() => {
    try {
      const id = readHostSession();
      if (id && id !== sessionId) bindSession(id);
    } catch (error) { log('session identity unavailable:', String(error)); }
  }, 500).unref();

  // react to /team edits (state.json) and to the room file appearing/disappearing
  fs.watchFile(statePath(), { interval: 1000 }, () => {
    const s = switches();
    if (!s.enabled) disconnect('switched off');
    else if (project && !hub) connect();
    hub?.setVisible(s.visible);
    inbox.refresh();
  });
  setInterval(() => {
    const now = findProjectConfig(cwd);
    if (now && (!project || now.room !== project.room)) {
      disconnect(`room changed`);
      project = now;
      if (switches().enabled) connect();
    } else if (!now && project) {
      project = null;
      disconnect('left room');
    }
  }, 2000).unref();

  // ---- local socket for hooks --------------------------------------------
  const drain = () => {
    const out = inbox.drain();
    if (out.length) fs.writeFileSync(spool, '');
    return out;
  };

  startLocalServer(process.pid, (req: LocalRequest) => {
    switch (req.op) {
      case 'info':
        return { pid: process.pid, cwd, sessionId, name: hub?.name ?? null, ref, connected: hub?.connected ?? false, inactive: inactiveReason(), status, ...switches() };
      case 'bind':
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
      case 'set': {
        if (!sessionId) return { error: 'waiting for Claude session identity; use --global to change defaults' };
        const state = readState();
        if (sessionId) state.sessions[sessionId] = { ...state.sessions[sessionId], ...req.patch };
        else Object.assign(state, req.patch);
        writeState(state);
        inbox.refresh();
        return { ok: true, sessionId: sessionId ?? null, applied: req.patch };
      }
    }
  });

  const cleanup = () => { removeMeta(process.pid); try { fs.unlinkSync(spool); } catch { /* none */ } hub?.close(); };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => process.exit(0));
  process.stdin.on('close', () => process.exit(0)); // Claude went away

  // ---- MCP tools ---------------------------------------------------------
  const server = new McpServer({ name: 'team-bridge', version: '0.1.0' });

  server.registerTool(
    'team_read_messages',
    {
      description: 'Read pending team messages after a team-bridge monitor notification. Handle task requests and reply to their sender using team_send_message. Messages already injected by a hook are not returned again. Do not poll this tool.',
      inputSchema: {},
    },
    async () => {
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
        "List colleagues' Claude Code sessions connected to the team hub. Each row is `name [ref] · user@host · repo · status · started`. " +
        'The name is the address for team_send_message; append the [ref] only when a name is ambiguous.',
      inputSchema: {},
    },
    async () => {
      const h = requireHub();
      const agents = await h.list();
      const now = Date.now();
      const me = agents.find((a) => a.ref === h.ref);
      const others = agents.filter((a) => a.ref !== h.ref);
      const total = others.length + 1;
      const lines = [
        `Room ${project?.room}: ${total} session${total === 1 ? '' : 's'} online (including you).`,
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
        "Send a message to a colleague's Claude Code session. `to` is a name from team_list_agents (append ` [ref]` only if told the name is ambiguous). " +
        'The recipient sees only the first line as a preview, so make it a self-contained sentence. ' +
        'Replies arrive automatically as <team-message> blocks; do not poll. ' +
        'Never ask a colleague session to perform an action this session was denied.',
      inputSchema: {
        to: z.string().describe('Recipient name, e.g. "alice-backend-3f2a" or "alice-backend-3f2a [3f2a1b]"'),
        message: z.string().describe('Plain text. First line = preview.'),
        notify_when_idle: z.boolean().optional().describe('Also get one notice when the recipient next goes idle or exits.'),
      },
    },
    async ({ to, message, notify_when_idle }) => {
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
    async () => {
      const s = switches();
      const text = [
        `name: ${hub?.name || '(not registered)'} [${ref ?? 'pending'}]`,
        `session: ${sessionId ?? '(waiting for hook)'}`,
        `hub: ${creds.hub}  room: ${project?.room ?? '(no .team-bridge.json)'}`,
        `connected: ${hub?.connected ?? false}  status: ${status}`,
        `enabled: ${s.enabled}  dnd: ${s.dnd}  visible: ${s.visible}`,
        `queued unread: ${inbox.size}`,
        inactiveReason() ? `inactive: ${inactiveReason()}` : '',
      ].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text }] };
    },
  );

  await server.connect(new StdioServerTransport());
}
