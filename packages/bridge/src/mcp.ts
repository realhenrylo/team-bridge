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
import { removeMeta, startLocalServer, writeMeta, type LocalRequest, type SockMeta } from './local';

const log = (...a: unknown[]) => console.error('[team-bridge]', ...a); // stdout is the MCP channel

export async function runMcp() {
  ensureDirs();
  const cwd = process.cwd();
  const creds = readCredentials();
  const project = findProjectConfig(cwd);
  const ref = crypto.randomBytes(3).toString('hex');
  const inbox: InboundMessage[] = [];
  const spool = path.join(DIRS.inbox, `${process.pid}.jsonl`);
  let sessionId: string | undefined;
  let status: 'busy' | 'idle' | 'shell' = 'idle';
  let hub: HubClient | null = null;
  // monitor processes long-polling for "something new arrived"
  const waiters = new Set<(preview: { from: string; preview: string } | null) => void>();
  const wake = (m: InboundMessage) => {
    const payload = { from: m.from, preview: (m.body.split('\n')[0] ?? '').slice(0, 120) };
    for (const w of waiters) w(payload);
    waiters.clear();
  };

  const meta: SockMeta = {
    pid: process.pid, ppid: process.ppid, cwd, startedAt: Date.now(),
    sock: path.join(DIRS.sock, `${process.pid}.sock`),
  };
  writeMeta(meta);

  const switches = () => effective(readState(), sessionId);

  const inactiveReason = () =>
    !project ? 'this project has no .team-bridge.json, so it is not in any room (/team join <code>)'
    : hub?.roomGone ? `room ${project.room} does not exist or has expired; create or join another (/team join <code>)`
    : !switches().enabled ? 'team bridge is switched off for this session (/team on to enable)'
    : null;

  // ---- hub connection ----------------------------------------------------
  if (project) {
    hub = new HubClient({
      hub: creds.hub, room: project.room, log,
      hello: {
        ref, user: creds.user, host: os.hostname(), cwd,
        repo: path.basename(project.root), visible: switches().visible, status,
      },
    });
    hub.on('message', (m: InboundMessage) => {
      inbox.push(m);
      fs.appendFileSync(spool, JSON.stringify(m) + '\n');
      if (switches().dnd) return;
      wake(m);
      if (status === 'idle') notifyDesktop(`Claude: message from ${m.from}`, m.body.split('\n')[0] ?? '');
    });
    hub.on('idle-notice', (n: { name: string; ref: string; reason: string }) => {
      const m: InboundMessage = {
        id: crypto.randomUUID(), from: n.name, fromRef: n.ref, at: Date.now(),
        body: `[idle notice] ${n.name} [${n.ref}] is now ${n.reason}.`,
      };
      inbox.push(m);
      if (!switches().dnd) wake(m);
    });
    hub.on('welcome', (w: { name: string; resumed: boolean }) => log(`registered as ${w.name}${w.resumed ? ' (resumed)' : ''}`));
    if (switches().enabled) hub.connect();

    // react to /team edits
    fs.watchFile(statePath(), { interval: 1000 }, () => {
      const s = switches();
      if (!s.enabled && hub?.connected) { hub.close(); hub = null; log('switched off'); }
      hub?.setVisible(s.visible);
    });
  } else {
    log(inactiveReason());
  }

  // ---- local socket for hooks --------------------------------------------
  const drain = () => {
    const out = inbox.splice(0, inbox.length);
    if (out.length) fs.writeFileSync(spool, '');
    return out;
  };

  startLocalServer(process.pid, (req: LocalRequest) => {
    switch (req.op) {
      case 'info':
        return { pid: process.pid, cwd, sessionId, name: hub?.name ?? null, ref, connected: hub?.connected ?? false, inactive: inactiveReason(), status, ...switches() };
      case 'bind':
        sessionId = req.sessionId;
        writeMeta({ ...meta, sessionId });
        return { ok: true };
      case 'status':
        status = req.status;
        hub?.setStatus(status);
        return { ok: true };
      case 'peek':
        return { count: switches().dnd ? 0 : inbox.length };
      case 'wait':
        return new Promise((resolve) => {
          const done = (p: { from: string; preview: string } | null) => { clearTimeout(t); waiters.delete(done); resolve({ message: p, pending: inbox.length }); };
          const t = setTimeout(() => done(null), Math.min(req.timeoutMs, 60_000));
          waiters.add(done);
        });
      case 'drain':
        return { messages: switches().dnd ? [] : drain() };
      case 'set': {
        const state = readState();
        if (sessionId) state.sessions[sessionId] = { ...state.sessions[sessionId], ...req.patch };
        else Object.assign(state, req.patch);
        writeState(state);
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
      const lines = [
        `This session is ${h.name} [${h.ref}]${me ? '' : ' (hidden)'} — the name colleagues use to message it.`,
        '',
        others.length ? `Team sessions (${others.length}):` : 'No other sessions are online right now.',
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
          ? 'delivered; it will be read at their next tool round'
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
        `name: ${hub?.name || '(not registered)'} [${ref}]`,
        `hub: ${creds.hub}  room: ${project?.room ?? '(no .team-bridge.json)'}`,
        `connected: ${hub?.connected ?? false}  status: ${status}`,
        `enabled: ${s.enabled}  dnd: ${s.dnd}  visible: ${s.visible}`,
        `queued unread: ${inbox.length}`,
        inactiveReason() ? `inactive: ${inactiveReason()}` : '',
      ].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text }] };
    },
  );

  await server.connect(new StdioServerTransport());
}
