import { DurableObject } from 'cloudflare:workers';
import {
  ClientMessage,
  parseTarget,
  sanitizeRepoName,
  type AgentInfo,
  type InboundMessage,
  type ServerMessage,
  type SessionStatus,
} from '@team-bridge/protocol';

export interface Env {
  TEAM_ROOM: DurableObjectNamespace<TeamRoom>;
  /** days without activity before a room is destroyed (default 7) */
  ROOM_IDLE_DAYS?: string;
}

/** Room metadata, kept in the DO's key-value storage under "room". */
interface RoomMeta {
  code: string;
  name: string;
  createdAt: number;
  lastActive: number;
  idleMs: number;
}

type Attachment = { ref: string };

type SessionRow = {
  ref: string;
  name: string;
  user: string;
  host: string;
  cwd: string;
  repo: string;
  status: SessionStatus;
  visible: number;
  online: number;
  started_at: number;
  last_seen: number;
};

type MessageRow = {
  id: string;
  to_ref: string;
  from_ref: string;
  from_name: string;
  body: string;
  created_at: number;
  delivered_at: number | null;
};

const STALE_MS = 5 * 60_000; // online but silent this long -> mark offline
const EXPIRE_MS = 24 * 3_600_000; // offline this long -> forget session + its mail
const ALARM_MS = 60_000;

/**
 * One TeamRoom per room code. Holds the session registry, routes messages
 * between live WebSockets, and queues mail for offline sessions. The DO
 * hibernates between events for free; a room that sees no activity for
 * `idleMs` is destroyed by its alarm and the code stops working.
 */
export class TeamRoom extends DurableObject<Env> {
  private meta: RoomMeta | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.meta = (await ctx.storage.get<RoomMeta>('room')) ?? null;
      if (this.meta) this.migrate();
    });
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        ref        TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        user       TEXT NOT NULL,
        host       TEXT NOT NULL,
        cwd        TEXT NOT NULL,
        repo       TEXT NOT NULL,
        status     TEXT NOT NULL,
        visible    INTEGER NOT NULL DEFAULT 1,
        online     INTEGER NOT NULL DEFAULT 1,
        started_at INTEGER NOT NULL,
        last_seen  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id           TEXT PRIMARY KEY,
        to_ref       TEXT NOT NULL,
        from_ref     TEXT NOT NULL,
        from_name    TEXT NOT NULL,
        body         TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS messages_to ON messages(to_ref, delivered_at);
      CREATE TABLE IF NOT EXISTS idle_subs (
        target_ref     TEXT NOT NULL,
        subscriber_ref TEXT NOT NULL,
        PRIMARY KEY (target_ref, subscriber_ref)
      );
    `);
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  // ---- room lifecycle -----------------------------------------------------

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;

    if (path === '/init' && req.method === 'POST') {
      if (this.meta) return json({ error: 'room exists' }, 409);
      const body = await req.json<{ code: string; name: string; idleDays: number }>();
      const now = Date.now();
      this.meta = { code: body.code, name: body.name, createdAt: now, lastActive: now, idleMs: body.idleDays * 86_400_000 };
      await this.ctx.storage.put('room', this.meta);
      this.migrate();
      await this.ctx.storage.setAlarm(now + ALARM_MS);
      return json(this.publicInfo());
    }

    if (!this.meta) return json({ error: 'no such room (never created, or expired)' }, 404);

    if (path === '/info') return json(this.publicInfo());

    // websocket join
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private publicInfo() {
    const m = this.meta!;
    const online = this.sql.exec(`SELECT COUNT(*) AS n FROM sessions WHERE online = 1`).one().n as number;
    return {
      code: m.code, name: m.name, createdAt: m.createdAt, lastActive: m.lastActive,
      expiresAt: m.lastActive + m.idleMs, online,
    };
  }

  private touch(now: number) {
    if (!this.meta) return;
    // write at most once a minute; the alarm reads it
    if (now - this.meta.lastActive < 60_000) return;
    this.meta.lastActive = now;
    void this.ctx.storage.put('room', this.meta);
  }

  private async destroy() {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(4004, 'room expired'); } catch { /* gone */ }
    }
    this.meta = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // ---- connection lifecycle ---------------------------------------------

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.send(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'not JSON' });
    }
    const res = ClientMessage.safeParse(parsed);
    if (!res.success) {
      return this.send(ws, { type: 'error', code: 'BAD_MESSAGE', message: res.error.message });
    }
    const msg = res.data;
    const att = ws.deserializeAttachment() as Attachment | null;
    this.touch(Date.now());

    if (msg.type === 'hello') return this.onHello(ws, msg);
    if (!att) return this.send(ws, { type: 'error', code: 'NOT_HELLO', message: 'send hello first' });

    const now = Date.now();
    this.sql.exec(`UPDATE sessions SET last_seen = ? WHERE ref = ?`, now, att.ref);

    switch (msg.type) {
      case 'ping':
        return this.send(ws, { type: 'pong', now });
      case 'status':
        this.sql.exec(`UPDATE sessions SET status = ? WHERE ref = ?`, msg.status, att.ref);
        if (msg.status === 'idle') this.fireIdle(att.ref, 'idle');
        return;
      case 'visibility':
        this.sql.exec(`UPDATE sessions SET visible = ? WHERE ref = ?`, msg.visible ? 1 : 0, att.ref);
        return;
      case 'list':
        return this.send(ws, { type: 'agents', reqId: msg.reqId, agents: this.listAgents() });
      case 'send':
        return this.onSend(ws, att.ref, msg);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.markGone(ws, 'exited');
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.markGone(ws, 'exited');
  }

  async alarm(): Promise<void> {
    if (!this.meta) return;
    const now = Date.now();
    const stale = this.sql
      .exec<SessionRow>(`SELECT * FROM sessions WHERE online = 1 AND last_seen < ?`, now - STALE_MS)
      .toArray();
    for (const s of stale) {
      this.sql.exec(`UPDATE sessions SET online = 0 WHERE ref = ?`, s.ref);
      this.fireIdle(s.ref, 'expired');
    }
    const expired = this.sql
      .exec<SessionRow>(`SELECT ref FROM sessions WHERE online = 0 AND last_seen < ?`, now - EXPIRE_MS)
      .toArray();
    for (const s of expired) {
      this.sql.exec(`DELETE FROM messages WHERE to_ref = ?`, s.ref);
      this.sql.exec(`DELETE FROM idle_subs WHERE target_ref = ? OR subscriber_ref = ?`, s.ref, s.ref);
      this.sql.exec(`DELETE FROM sessions WHERE ref = ?`, s.ref);
    }
    const anyOnline = this.sql.exec(`SELECT 1 FROM sessions WHERE online = 1 LIMIT 1`).toArray().length > 0;
    if (anyOnline) {
      this.touch(now);
      await this.ctx.storage.setAlarm(now + ALARM_MS);
      return;
    }
    // nobody here: either expire the room or check back when it would expire
    const expiresAt = this.meta.lastActive + this.meta.idleMs;
    if (now >= expiresAt) await this.destroy();
    else await this.ctx.storage.setAlarm(expiresAt);
  }

  // ---- handlers -----------------------------------------------------------

  private async onHello(ws: WebSocket, msg: Extract<ClientMessage, { type: 'hello' }>) {
    const now = Date.now();
    const repo = sanitizeRepoName(msg.repo);
    const existing = this.sql.exec<SessionRow>(`SELECT * FROM sessions WHERE ref = ?`, msg.ref).toArray()[0] ?? null;

    let name: string;
    let resumed = false;
    if (existing) {
      // same bridge process reconnecting: keep its name, flush its mail
      name = existing.name;
      resumed = true;
      this.sql.exec(
        `UPDATE sessions SET online = 1, last_seen = ?, status = ?, visible = ?, cwd = ?, host = ? WHERE ref = ?`,
        now, msg.status, msg.visible ? 1 : 0, msg.cwd, msg.host, msg.ref,
      );
    } else {
      name = `${msg.user}-${repo}-${msg.ref.slice(0, 4)}`;
      this.sql.exec(
        `INSERT INTO sessions (ref, name, user, host, cwd, repo, status, visible, online, started_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        msg.ref, name, msg.user, msg.host, msg.cwd, repo, msg.status, msg.visible ? 1 : 0, now, now,
      );
    }

    // drop any older socket that still claims this ref (reconnect before close fired)
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const a = other.deserializeAttachment() as Attachment | null;
      if (a?.ref === msg.ref) {
        try { other.close(4000, 'superseded'); } catch { /* already gone */ }
      }
    }
    ws.serializeAttachment({ ref: msg.ref } satisfies Attachment);

    const pending = this.sql
      .exec<MessageRow>(`SELECT * FROM messages WHERE to_ref = ? AND delivered_at IS NULL ORDER BY created_at`, msg.ref)
      .toArray();
    if (pending.length) {
      this.sql.exec(`UPDATE messages SET delivered_at = ? WHERE to_ref = ? AND delivered_at IS NULL`, now, msg.ref);
    }

    this.send(ws, { type: 'welcome', name, ref: msg.ref, resumed, pending: pending.map(toInbound) });

    if ((await this.ctx.storage.getAlarm()) == null) {
      await this.ctx.storage.setAlarm(now + ALARM_MS);
    }
  }

  private onSend(ws: WebSocket, fromRef: string, msg: Extract<ClientMessage, { type: 'send' }>) {
    const from = this.sql.exec<SessionRow>(`SELECT * FROM sessions WHERE ref = ?`, fromRef).one();
    const { name, ref } = parseTarget(msg.to);

    let rows: SessionRow[];
    if (ref) {
      rows = this.sql.exec<SessionRow>(`SELECT * FROM sessions WHERE ref = ?`, ref).toArray();
      if (name && rows[0] && rows[0].name !== name) rows = [];
    } else {
      rows = this.sql.exec<SessionRow>(`SELECT * FROM sessions WHERE name = ?`, name!).toArray();
      if (rows.length > 1) {
        const online = rows.filter((r) => r.online);
        if (online.length === 1) rows = online;
      }
    }

    if (rows.length === 0) {
      return this.send(ws, {
        type: 'error', reqId: msg.reqId, code: 'UNKNOWN_AGENT',
        message: `no agent named "${msg.to}"; run team_list_agents to see who is around`,
      });
    }
    if (rows.length > 1) {
      return this.send(ws, {
        type: 'error', reqId: msg.reqId, code: 'AMBIGUOUS_NAME',
        message: `"${msg.to}" matches ${rows.length} sessions; append the [ref]`,
        candidates: rows.map(toAgent),
      });
    }

    const target = rows[0]!;
    const now = Date.now();
    const id = crypto.randomUUID();
    const inbound: InboundMessage = { id, from: from.name, fromRef: from.ref, body: msg.body, at: now };

    const targetWs = this.socketFor(target.ref);
    const delivered = targetWs ? this.trySend(targetWs, { type: 'message', message: inbound }) : false;

    this.sql.exec(
      `INSERT INTO messages (id, to_ref, from_ref, from_name, body, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, target.ref, from.ref, from.name, msg.body, now, delivered ? now : null,
    );

    if (msg.notifyWhenIdle) {
      this.sql.exec(`INSERT OR IGNORE INTO idle_subs (target_ref, subscriber_ref) VALUES (?, ?)`, target.ref, from.ref);
    }

    this.send(ws, {
      type: 'sent', reqId: msg.reqId, id, to: target.name, toRef: target.ref,
      state: delivered ? 'delivered' : 'queued',
    });
  }

  // ---- helpers ------------------------------------------------------------

  private listAgents(): AgentInfo[] {
    return this.sql
      .exec<SessionRow>(`SELECT * FROM sessions WHERE online = 1 AND visible = 1 ORDER BY started_at`)
      .toArray()
      .map(toAgent);
  }

  private markGone(ws: WebSocket, reason: 'exited') {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    // another socket may already own this ref (superseded reconnect)
    const stillLive = this.ctx.getWebSockets().some((o) => o !== ws && (o.deserializeAttachment() as Attachment | null)?.ref === att.ref);
    if (stillLive) return;
    this.sql.exec(`UPDATE sessions SET online = 0, last_seen = ? WHERE ref = ?`, Date.now(), att.ref);
    this.fireIdle(att.ref, reason);
  }

  private fireIdle(targetRef: string, reason: 'idle' | 'exited' | 'expired') {
    const subs = this.sql
      .exec<{ subscriber_ref: string }>(`SELECT subscriber_ref FROM idle_subs WHERE target_ref = ?`, targetRef)
      .toArray();
    if (!subs.length) return;
    const target = this.sql.exec<SessionRow>(`SELECT * FROM sessions WHERE ref = ?`, targetRef).one();
    for (const s of subs) {
      const ws = this.socketFor(s.subscriber_ref);
      if (ws) this.trySend(ws, { type: 'idle-notice', name: target.name, ref: target.ref, reason });
    }
    this.sql.exec(`DELETE FROM idle_subs WHERE target_ref = ?`, targetRef);
  }

  private socketFor(ref: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.ref === ref) return ws;
    }
    return null;
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    this.trySend(ws, msg);
  }

  private trySend(ws: WebSocket, msg: ServerMessage): boolean {
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function toAgent(r: SessionRow): AgentInfo {
  return {
    name: r.name, ref: r.ref, user: r.user, host: r.host, cwd: r.cwd, repo: r.repo,
    status: r.status, online: r.online === 1, startedAt: r.started_at, lastSeen: r.last_seen,
  };
}

function toInbound(m: MessageRow): InboundMessage {
  return { id: m.id, from: m.from_name, fromRef: m.from_ref, body: m.body, at: m.created_at };
}
