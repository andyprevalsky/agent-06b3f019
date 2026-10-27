import type {
  IMessageData,
  MessagingUploadOptions,
  UploadResult,
  AuthSession,
} from '../../../shared/types/ipc';
import type { NormalizedMessage, SyncEvent } from '../../services/messaging/types';

export type {
  IMessageData,
  MessagingUploadOptions,
  UploadResult,
  AuthSession,
  NormalizedMessage,
  SyncEvent,
};

/**
 * Integration record returned by IntegrationCache.getIntegration().
 */
export interface Integration {
  name: string;
  status: string;
  lastSyncAt?: string | null;
  config?: Record<string, unknown>;
}

/**
 * Subset of the integration config consumed by this domain.
 */
export interface IntegrationConfig {
  lastFrontendAccessAt?: string;
}
