import type { IPhoneDevice, IPhoneLease, IPhoneOperation, Prisma } from '@prisma/client';

export type { IPhoneDevice, IPhoneLease, IPhoneOperation };
export type Transaction = Prisma.TransactionClient;
export type LeaseAction = 'read' | 'heartbeat' | 'release' | 'awaiting-auth' | 'control';
export interface AcquireInput {
  agentId: string;
  requestKey: string;
  browserTaskId?: string;
}
export interface ActionInput {
  attentionRequestId?: string;
  mode?: 'user' | 'agent';
}
export { PhoneInteractionError as IPhoneError } from '../../providers/phoneInteractionError';
export interface Capability {
  enabled: boolean;
  configured: boolean;
  setupState: string | null;
}

export * from '../../providers/phoneAccountPolicy';
