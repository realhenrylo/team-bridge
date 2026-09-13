import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { agentFor } from './net';
import {
  ServerMessage,
  type AgentInfo,
  type ClientMessage,
  type InboundMessage,
  type SessionStatus,
} from '@agent-room/protocol';

export interface HubClientOptions {
  hub: string;
  room: string;
  hello: Omit<Extract<ClientMessage, { type: 'hello' }>, 'type'>;
  log: (...a: unknown[]) => void;
}

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

interface Pending {
  resolve: (m: ServerMessage) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Long-lived WebSocket to the TeamRoom. Reconnects with backoff and replays
 * hello (same ref) so the hub resumes our identity and flushes queued mail.
 */
export class HubClient extends EventEmitter {
  name = '';
  ref: string;
  connected = false;
  /** set when the hub says the room does not exist / expired; no reconnects after that */
  roomGone = false;
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private backoff = 1000;
  private closed = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private status: SessionStatus;
  private visible: boolean;

  constructor(private opts: HubClientOptions) {
    super();
    this.ref = opts.hello.ref;
    this.status = opts.hello.status ?? 'idle';
    this.visible = opts.hello.visible ?? true;
  }

  connect() {
    if (this.closed) return;
    const url = new URL('/ws', this.opts.hub);
    url.searchParams.set('room', this.opts.room);
    const agent = agentFor(url);
    if (agent) this.opts.log('connecting via proxy');
    const ws = new WebSocket(url, { agent });
    this.ws = ws;

    ws.on('open', () => {
      this.opts.log('connected, sending hello');
      this.raw({ type: 'hello', ...this.opts.hello, status: this.status, visible: this.visible });
      this.pingTimer = setInterval(() => this.raw({ type: 'ping' }), 30_000);
    });
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('close', (code, reason) => {
      this.connected = false;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.emit('disconnected');
      if (code === 4000) return; // superseded by a newer socket of ours
      if (code === 4004) {
        this.roomGone = true;
        this.opts.log('room expired, giving up');
        return;
      }
      if (!this.closed) {
        this.opts.log(`closed (${code} ${reason}), reconnecting in ${this.backoff}ms`);
        setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 30_000);
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 404) {
        this.roomGone = true;
        this.closed = true;
        this.opts.log(`room ${this.opts.room} does not exist or has expired`);
      }
    });
    ws.on('error', (e) => this.opts.log('ws error', e.message));
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }

  setStatus(status: SessionStatus) {
    this.status = status;
    this.raw({ type: 'status', status });
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.raw({ type: 'visibility', visible });
  }

  async list(): Promise<AgentInfo[]> {
    const res = await this.request({ type: 'list' });
    if (res.type === 'agents') return res.agents;
    throw new Error(res.type === 'error' ? res.message : 'unexpected reply');
  }

  async send(to: string, body: string, notifyWhenIdle?: boolean) {
    const res = await this.request({ type: 'send', to, body, notifyWhenIdle });
    if (res.type === 'sent') return res;
    if (res.type === 'error') {
      const e = new Error(res.message) as Error & { code?: string; candidates?: AgentInfo[] };
      e.code = res.code;
      e.candidates = res.candidates;
      throw e;
    }
    throw new Error('unexpected reply');
  }

  // ---- internals ----------------------------------------------------------

  private request(msg: DistributiveOmit<Extract<ClientMessage, { reqId: string }>, 'reqId'>): Promise<ServerMessage> {
    if (!this.connected) return Promise.reject(new Error('not connected to hub'));
    const reqId = Math.random().toString(36).slice(2, 10);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error('hub timeout'));
      }, 10_000);
      this.pending.set(reqId, { resolve, reject, timer });
      this.raw({ ...msg, reqId } as ClientMessage);
    });
  }

  private raw(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(text: string) {
    const parsed = ServerMessage.safeParse(JSON.parse(text));
    if (!parsed.success) return this.opts.log('bad server message', parsed.error.message);
    const m = parsed.data;
    switch (m.type) {
      case 'welcome':
        this.name = m.name;
        this.connected = true;
        this.backoff = 1000;
        this.emit('welcome', m);
        for (const msg of m.pending) this.emit('message', msg as InboundMessage);
        return;
      case 'message':
        return void this.emit('message', m.message);
      case 'idle-notice':
        return void this.emit('idle-notice', m);
      case 'pong':
        return;
      default: {
        const p = 'reqId' in m && m.reqId ? this.pending.get(m.reqId) : undefined;
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(m.reqId!);
          p.resolve(m);
        } else if (m.type === 'error') {
          this.opts.log('hub error', m.code, m.message);
        }
      }
    }
  }
}
