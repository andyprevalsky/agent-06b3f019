import type { IPhoneDevice, IPhoneLease, IPhoneOperation } from './types';
import type { PhoneHarnessClient } from '../../providers/phoneHarness';

export type PhoneActor = 'agent' | 'user';
export interface PhoneCommand {
  operationId: string;
  operation: string;
  args: Record<string, unknown>;
}
export interface CommandPayload {
  operation: string;
  args: Record<string, unknown>;
  actor: PhoneActor;
}
export interface CommandClaim {
  device: IPhoneDevice;
  lease: IPhoneLease;
  command: IPhoneOperation;
  execute: boolean;
}
export type PhoneClientFactory = () => PhoneHarnessClient;
