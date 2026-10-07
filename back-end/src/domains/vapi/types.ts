export interface CreateCallRequest {
  to: string;
  system_prompt: string;
  output_schema: Record<string, unknown>;
  idempotency_key?: string;
  user_id?: string;
}

export interface VapiCallResponse {
  id: string;
  status: string;
  [key: string]: unknown;
}

/**
 * Hold-capable call lifecycle (one Twilio call, many Vapi segments):
 *
 *   dialing ──Twilio answers──▶ connected ──wait_for_human──▶ on_hold
 *      │                          ▲   │                          │
 *      │                          │   │              live person │
 *      │                          │   ▼                          ▼
 *      └──no-answer/busy──▶     ended ◀──hangup / max hold── reconnecting
 *                                 ▲                              │
 *                                 └────────── new Vapi segment ◀─┘
 */
export type PhoneCallSessionState = 'dialing' | 'connected' | 'on_hold' | 'reconnecting' | 'ended';

export interface PhoneCallSegment {
  vapiCallId: string;
  startedAt: string;
  /** Terminal Vapi call object, cached once its analysis is final. */
  final?: Record<string, unknown> | null;
}

export interface HoldUtterance {
  at: string;
  text: string;
  liveHuman: boolean;
  reason?: string;
}

export interface PhoneHoldPeriod {
  startedAt: string;
  endedAt?: string;
  heard?: string;
  humanUtterance?: string;
  streamConnects: number;
  utterances: HoldUtterance[];
}

export interface PhoneCallSessionRecord {
  id: string;
  operationKey: string | null;
  agentId: string | null;
  userId: string | null;
  rootVapiCallId: string | null;
  activeVapiCallId: string | null;
  twilioCallSid: string | null;
  phoneNumberId: string;
  fromNumber: string;
  toNumber: string;
  state: PhoneCallSessionState;
  assistantConfig: Record<string, unknown>;
  segments: PhoneCallSegment[];
  holds: PhoneHoldPeriod[];
  endedReason: string | null;
  endedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
