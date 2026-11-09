import type { IPhoneDevice, IPhoneLease, IPhoneOperation } from './types';
import type { PhoneHarnessClient } from '../../providers/phoneHarness';

export type PhoneActor = 'agent' | 'user';
export interface PhoneCommand {
  operationId: string;
  operation: string;
  args: Record<string, unknown>;
  expectedCursor?: number;
  attentionRequestId?: string;
  setupAttemptId?: string;
  setupRevision?: number;
}
export interface CommandPayload {
  operation: string;
  args: Record<string, unknown>;
  actor: PhoneActor;
  attentionRequestId?: string;
  setupAttemptId?: string;
  setupRevision?: number;
}
export interface CommandClaim {
  device: IPhoneDevice;
  lease: IPhoneLease;
  command: IPhoneOperation;
  execute: boolean;
  taskBound?: boolean;
  /** Server-only admission snapshot; never supplied by callers or reconstructed for replay. */
  executionGeneration?: string;
  executionFirstExecutionRunId?: string;
}
export type PhoneClientFactory = () => PhoneHarnessClient;
