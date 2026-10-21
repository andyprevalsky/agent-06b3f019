/**
 * Browser-session domain types — Zod schemas, interfaces, type aliases.
 */

import { z } from 'zod';

export { BrowserControlState, BrowserSessionStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// Request validation schemas
// ---------------------------------------------------------------------------

export const initSessionSchema = z.object({
  user_id: z.string(),
  agent_id: z.string().uuid(),
  start_url: z.string().min(1),
  task_id: z.string().uuid().optional(),
});

export const closeSessionSchema = z.object({
  session_id: z.string(),
  pause: z.boolean().optional().default(false),
  current_url: z.string().optional(), // Save current page URL for resume
});

const storageStateSchema = z
  .object({
    cookies: z.array(z.record(z.unknown())).default([]),
    origins: z.array(z.record(z.unknown())).default([]),
  })
  .passthrough();

export const resumeSessionSchema = z.object({
  task_id: z.string().uuid(), // Use stable task ID instead of session_id
  force_fresh_profile: z.boolean().optional().default(false),
  /** Worker-captured state of a LIVE Tilion session (it holds the only CDP client). */
  storage_state: storageStateSchema.optional(),
});

export const browserControlSchema = z.object({
  mode: z.enum(['user', 'agent', 'acknowledge']),
});

// rotate_ip tool → swap the browser session's outbound IP for the sub-agent run
// identified by task_id (the stable BrowserSession row id / escalation key).
export const rotateProxySchema = z.object({
  task_id: z.string().uuid(),
  current_url: z.string().min(1).max(8192).optional(),
  /** Worker-captured state of a LIVE Tilion session; required by Tilion to replace it. */
  storage_state: storageStateSchema.optional(),
});

const httpPublicUrlSchema = z
  .string()
  .url()
  .max(8192)
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }, 'URL must use http or https');

export const recoverChallengeSchema = z.object({
  task_id: z.string().uuid(),
  current_url: httpPublicUrlSchema,
  storage_state: storageStateSchema,
  /**
   * Parallel cookie-signature lanes for config search. Each lane keeps its own
   * storage identity; configs are tried sequentially inside a lane. When omitted,
   * ``storage_state`` is used as a single ``default`` lane.
   */
  storage_lanes: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        storage_state: storageStateSchema,
      })
    )
    .min(1)
    .max(4)
    .optional(),
  user_agent: z.string().max(2048).optional(),
  /** Agent-facing recovery reason forwarded into the LLM challenge classifier. */
  recovery_reason: z.string().max(4000).optional(),
  /** Failure-driven blocked third-party URL that triggered this recovery. */
  blocked_resource_url: httpPublicUrlSchema.optional(),
  /**
   * @deprecated Ignored. Promote uses the single LLM gate only (blocked resource
   * URL is folded into classifier recovery_reason evidence when present).
   */
  require_payment_cdn: z.boolean().optional(),
  /**
   * When false, the agent may include a fully stripped cookie lane. Informational
   * for logs; lane membership is decided by the caller via storage_lanes.
   */
  preserve_auth: z.boolean().optional(),
  /**
   * Cross-recovery blacklist of config keys that already failed a probe or
   * failed again after promote. Backend excludes them unless the blacklist
   * covers the whole catalog (then it expires and the full catalog is retried).
   */
  blocked_config_keys: z.array(z.string().min(1).max(64)).max(32).optional(),
});

/**
 * Cookie-isolation probes on ephemeral Kernel/Steel sessions (never the live
 * debug desktop). One storage variant per request; the agent parallelizes ≤5.
 */
export const probeCookieVariantSchema = z.object({
  task_id: z.string().uuid(),
  current_url: z.string().url().max(8192),
  storage_state: storageStateSchema,
  user_agent: z.string().max(2048).optional(),
  recovery_reason: z.string().max(4000).optional(),
  blocked_resource_url: z.string().url().max(8192).optional(),
  blocked_config_keys: z.array(z.string().min(1).max(64)).max(32).optional(),
});

export const injectLocalStorageSchema = z.object({
  origin: z.string().url(),
});

export const prepareSessionCredentialsSchema = z.object({
  target_url: z.string().min(1).max(8192),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type InitSessionInput = z.infer<typeof initSessionSchema>;
export type CloseSessionInput = z.infer<typeof closeSessionSchema>;
export type ResumeSessionInput = z.infer<typeof resumeSessionSchema>;
export type RotateProxyInput = z.infer<typeof rotateProxySchema>;
export type RecoverChallengeInput = z.infer<typeof recoverChallengeSchema>;
export type ProbeCookieVariantInput = z.infer<typeof probeCookieVariantSchema>;
export type InjectLocalStorageInput = z.infer<typeof injectLocalStorageSchema>;
export type PrepareSessionCredentialsInput = z.infer<typeof prepareSessionCredentialsSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CdpInjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CdpInjectionError';
  }
}

export class SessionNoWsUrlError extends Error {
  constructor() {
    super('Session has no WebSocket URL for CDP injection');
    this.name = 'SessionNoWsUrlError';
  }
}

// ---------------------------------------------------------------------------
// Response / domain types
// ---------------------------------------------------------------------------

export interface SerializedPassword {
  id: string;
  origin: string;
  username: string;
  encryptedPassword: string;
  dateLastUsed: number | null;
}

// Passkey material for runtime injection into a CDP virtual authenticator.
// encryptedPrivateKey stays encrypted over the wire (decrypted in the agent
// activity, never shown to the LLM). signCount is the block-reserved base the
// authenticator is seeded with — see repo.reservePasskeysForRealm.
export interface SerializedPasskey {
  id: string;
  credentialId: string;
  encryptedPrivateKey: string;
  rpId: string;
  userHandle: string | null;
  signCount: number;
}

export interface UserSettings {
  name: string | null;
  email: string | null;
  phone: string | null;
  deliveryRecipientName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  encryptedPaymentInformation: string | null;
  systemName: string | null;
  profilePicture: string | null;
  customSystemPrompt: string | null;
}
