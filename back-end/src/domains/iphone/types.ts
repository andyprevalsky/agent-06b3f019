import type { IPhoneDevice, IPhoneLease, Prisma } from '@prisma/client';

export type { IPhoneDevice, IPhoneLease };
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
export class IPhoneError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}
export interface Capability {
  enabled: boolean;
  configured: boolean;
  setupState: string | null;
}
