import { createLogger } from '../../providers/logger';
import { resolvePendingGateByKey } from '../../providers/gateResolution';
import type { EmailProviderSlug } from './types';

const log = createLogger('Integrations');

export async function resolveSourceConnectGate(
  userId: string,
  providerKey: EmailProviderSlug
): Promise<void> {
  try {
    await resolvePendingGateByKey(userId, `source_connect:${providerKey}`, 'SOURCE_CONNECTED');
  } catch (error: unknown) {
    log.warn('Failed to resolve source-connect gate after OAuth', {
      userId,
      providerKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
