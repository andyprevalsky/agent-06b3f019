import type { AgentStatus } from '@prisma/client';

export type CredentialKind =
  | 'cookie_bundle'
  | 'password'
  | 'steel_session'
  | 'email_otp'
  | 'minted'
  | 'passkey';

export interface CredentialRef {
  kind: CredentialKind;
  id: string;
}

export type CredentialPropagationOutcome =
  | 'success'
  | 'auth_failed'
  | 'captcha'
  | 'antibot'
  | 'rate_limited'
  | 'account_locked'
  | 'task_level'
  | 'unknown';

export interface PropagationDecision {
  outcome: CredentialPropagationOutcome;
  reason: string;
  rawError: string | null;
  failureReason: string | null;
}

export interface AgentForPropagation {
  id: string;
  userId?: string;
  goal: string;
  status: AgentStatus;
  statusMessage: string | null;
}
