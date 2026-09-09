import { Hono } from 'hono';
import type { Env } from './room';

export { TeamRoom } from './room';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true, now: Date.now() }));

/**
 * Create a room. If CREATE_TOKEN is set, creation requires it (so strangers
 * who find the hub URL can't fill it with rooms); joining only needs the code.
 */
app.post('/rooms', async (c) => {
  if (c.env.CREATE_TOKEN) {
    const auth = c.req.header('Authorization') ?? '';
    if (auth !== `Bearer ${c.env.CREATE_TOKEN}`) return c.text('unauthorized', 401);
  }
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const code = newRoomCode();
  const stub = c.env.TEAM_ROOM.get(c.env.TEAM_ROOM.idFromName(code));
  const res = await stub.fetch('https://room/init', {
    method: 'POST',
    body: JSON.stringify({ code, name: body.name ?? '', idleDays: idleDays(c.env) }),
  });
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
});

app.get('/rooms/:code', async (c) => {
  const code = normalizeCode(c.req.param('code'));
  if (!code) return c.text('bad room code', 400);
  const stub = c.env.TEAM_ROOM.get(c.env.TEAM_ROOM.idFromName(code));
  return stub.fetch('https://room/info');
});

// wss://<host>/ws?room=XXXX-XXXX
app.get('/ws', (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('expected websocket upgrade', 426);
  }
  const code = normalizeCode(c.req.query('room') ?? '');
  if (!code) return c.text('bad room code', 400);
  const stub = c.env.TEAM_ROOM.get(c.env.TEAM_ROOM.idFromName(code));
  return stub.fetch(c.req.raw);
});

export default app;

// no 0/O/1/I; 8 chars -> ~1e12 codes, enough that guessing is impractical
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export function normalizeCode(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== 8 || [...s].some((ch) => !ALPHABET.includes(ch))) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function idleDays(env: Env): number {
  const n = Number(env.ROOM_IDLE_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
}
