import type { PhoneCriticalReason } from '../../providers/nativePhoneAttention';

export const AUTH_ASSISTANCE_MODES = [
  'live_view',
  'local_browser',
  'manual_otp',
  'manual_step',
] as const;

export type AuthAssistanceMode = (typeof AUTH_ASSISTANCE_MODES)[number];

export interface CreateAuthAssistanceInput {
  agentId: string;
  authRealm: string;
  mode: AuthAssistanceMode;
  browserSessionId?: string;
  steelSessionId?: string;
  browserUrl?: string;
  currentUrl?: string;
  targetKind?: 'iphone' | 'browser';
  browserTaskId?: string;
  criticalReason?: PhoneCriticalReason;
  requestKey?: string;
  expectedCursor?: number;
}

export interface SerializedAuthAssistanceRequest {
  id: string;
  agentId: string;
  userId: string;
  authRealm: string;
  browserSessionId: string | null;
  steelSessionId: string;
  mode: string;
  createdAt: string;
  completedAt: string | null;
}

export interface AuthAssistanceHandoff {
  type: AuthAssistanceMode;
  liveViewUrl: string | null;
  steelSessionId: string | null;
}
