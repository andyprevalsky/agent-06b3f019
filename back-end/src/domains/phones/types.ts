/**
 * /api/phones — request schemas and the wire contract the UI renders.
 *
 * A phone is an iPhone attached to one of the user's Macs and shown through
 * macOS iPhone Mirroring. Exactly one holder (an agent or the user) controls
 * it at a time; see service.ts for the state machine.
 */
import { z } from 'zod';

export const PHONE_KIND_IPHONE_MIRRORING = 'iphone_mirroring';
export type PhoneKind = typeof PHONE_KIND_IPHONE_MIRRORING;

/** POST /api/phones/register — the Mac app's presence heartbeat (upsert). */
export const registerPhoneSchema = z.object({
  macDeviceId: z.string().trim().min(8).max(128),
  name: z.string().trim().min(1).max(120),
  model: z.string().trim().max(120).nullish(),
  kind: z.literal(PHONE_KIND_IPHONE_MIRRORING).default(PHONE_KIND_IPHONE_MIRRORING),
  online: z.boolean(),
});
export type RegisterPhoneBody = z.infer<typeof registerPhoneSchema>;

/** Agent lease operations (internal API key; `user_id` resolves the owner). */
export const agentPhoneLeaseSchema = z.object({
  agent_id: z.string().trim().min(1).max(128),
  lease_id: z.string().uuid().optional(),
});
export type AgentPhoneLeaseBody = z.infer<typeof agentPhoneLeaseSchema>;

export const phoneIdSchema = z.string().uuid();

/** GET /api/phones/:id/frame?after=<seq> — only return a newer frame. */
export const frameQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
});

/** GET /api/phones/:id/stream-demand?waitMs=<ms> — Mac long-poll. */
export const streamDemandQuerySchema = z.object({
  waitMs: z.coerce.number().int().min(0).max(25_000).optional(),
});

export type PhoneHolder =
  | { kind: 'agent'; agentId: string; agentTitle: string | null; leaseExpiresAt: string }
  | { kind: 'user'; leaseExpiresAt: string }
  | { kind: null };

/** The UI contract (GET /api/phones, take-control, release, register). */
export interface PhoneState {
  id: string;
  name: string;
  model: string | null;
  kind: PhoneKind;
  macDeviceId: string;
  /** The Mac heartbeat is fresh and iPhone Mirroring reports connected. */
  online: boolean;
  lastSeenAt: string;
  holder: PhoneHolder;
  /** Agent whose control the user took; it can reacquire after release. */
  resumeAgent: { agentId: string; agentTitle: string | null } | null;
  /** Latest relayed screen frame, if one is fresh (see GET /:id/frame). */
  frame: { seq: number; capturedAt: string; width: number; height: number } | null;
}

/** What the Mac should capture right now (bounded, on demand). */
export interface PhoneStreamDemand {
  requested: boolean;
  maxFps: number;
  maxWidth: number;
  jpegQuality: number;
}

/** Agent lease receipt (acquire / heartbeat). */
export interface PhoneAgentLease {
  phoneId: string;
  leaseId: string;
  leaseExpiresAt: string;
  heartbeatIntervalMs: number;
}

/** Fail-fast agent errors (HTTP 409 unless noted); messages are tool-visible. */
export type PhoneControlErrorCode =
  | 'PHONE_CONTROL_TAKEN'
  | 'PHONE_IN_USE_BY_USER'
  | 'PHONE_IN_USE_BY_AGENT'
  | 'PHONE_LEASE_LOST'
  | 'PHONE_OFFLINE'
  | 'PHONE_CONTROL_CONFLICT'
  | 'PHONE_NOT_FOUND'
  | 'AGENT_NOT_FOUND';
