import { z } from 'zod';

// ---- shared shapes -------------------------------------------------------

export const SessionStatus = z.enum(['busy', 'idle', 'shell']);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const Ref = z.string().regex(/^[0-9a-f]{6}$/);

export const AgentInfo = z.object({
  name: z.string(),
  ref: Ref,
  user: z.string(),
  host: z.string(),
  cwd: z.string(),
  repo: z.string(),
  status: SessionStatus,
  online: z.boolean(),
  startedAt: z.number(),
  lastSeen: z.number(),
});
export type AgentInfo = z.infer<typeof AgentInfo>;

export const InboundMessage = z.object({
  id: z.string(),
  from: z.string(),
  fromRef: Ref,
  body: z.string(),
  at: z.number(),
});
export type InboundMessage = z.infer<typeof InboundMessage>;

// ---- client -> hub -------------------------------------------------------

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    // client-generated, stable for the life of the bridge process so a
    // reconnect resumes the same identity and picks up queued messages
    ref: Ref,
    user: z.string().min(1),
    host: z.string(),
    cwd: z.string(),
    repo: z.string(),
    visible: z.boolean().default(true),
    status: SessionStatus.default('idle'),
  }),
  z.object({ type: z.literal('status'), status: SessionStatus }),
  z.object({ type: z.literal('visibility'), visible: z.boolean() }),
  z.object({ type: z.literal('list'), reqId: z.string() }),
  z.object({
    type: z.literal('send'),
    reqId: z.string(),
    to: z.string().min(1),
    body: z.string().min(1).max(64 * 1024),
    notifyWhenIdle: z.boolean().optional(),
  }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---- hub -> client -------------------------------------------------------

export const ErrorCode = z.enum([
  'UNAUTHORIZED',
  'NOT_HELLO',
  'UNKNOWN_AGENT',
  'AMBIGUOUS_NAME',
  'BAD_MESSAGE',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ServerMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    name: z.string(),
    ref: Ref,
    resumed: z.boolean(),
    pending: z.array(InboundMessage),
  }),
  z.object({ type: z.literal('agents'), reqId: z.string(), agents: z.array(AgentInfo) }),
  z.object({ type: z.literal('message'), message: InboundMessage }),
  z.object({
    type: z.literal('sent'),
    reqId: z.string(),
    id: z.string(),
    to: z.string(),
    toRef: Ref,
    state: z.enum(['delivered', 'queued']),
  }),
  z.object({
    type: z.literal('error'),
    reqId: z.string().optional(),
    code: ErrorCode,
    message: z.string(),
    candidates: z.array(AgentInfo).optional(),
  }),
  z.object({
    type: z.literal('idle-notice'),
    name: z.string(),
    ref: Ref,
    reason: z.enum(['idle', 'exited', 'expired']),
  }),
  z.object({ type: z.literal('pong'), now: z.number() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// ---- helpers shared by hub and client -----------------------------------

/** "name [ref]" | "name" | "ref" */
export function parseTarget(to: string): { name?: string; ref?: string } {
  const t = to.trim();
  const m = /^(.*?)\s*\[([0-9a-f]{6})\]$/.exec(t);
  if (m) return { name: m[1]!.trim() || undefined, ref: m[2] };
  if (/^[0-9a-f]{6}$/.test(t)) return { ref: t };
  return { name: t };
}

export function relativeTime(fromMs: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Mirrors the built-in ListAgents row format. */
export function formatAgentLine(a: AgentInfo, nowMs = Date.now()): string {
  const status = a.online ? a.status : 'offline';
  return `${a.name} [${a.ref}]  ·  ${a.user}@${a.host}  ·  ${a.repo}  ·  ${status}  ·  started ${relativeTime(a.startedAt, nowMs)}`;
}

export function sanitizeRepoName(repo: string): string {
  return repo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}
