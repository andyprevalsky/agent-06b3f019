/**
 * Browser-session domain types — Zod schemas, interfaces, type aliases.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Request validation schemas
// ---------------------------------------------------------------------------

export const initSessionSchema = z.object({
  user_id: z.string(),
  agent_id: z.string().uuid(),
  start_url: z.string().min(1),
});

export const closeSessionSchema = z.object({
  session_id: z.string(),
  pause: z.boolean().optional().default(false),
  current_url: z.string().optional(), // Save current page URL for resume
});

export const resumeSessionSchema = z.object({
  task_id: z.string().uuid(), // Use stable task ID instead of session_id
});

export const browserControlSchema = z.object({
  mode: z.enum(['user', 'agent', 'acknowledge']),
});

// rotate_ip tool → swap the browser session's outbound IP for the sub-agent run
// identified by task_id (the stable BrowserSession row id / escalation key).
export const rotateProxySchema = z.object({
  task_id: z.string().uuid(),
  current_url: z.string().min(1).max(8192).optional(),
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
  phone: string | null;
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
