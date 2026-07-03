import { createLogger } from '../../providers/logger';
import { archiveJson } from '../../providers/traceArchive';

const log = createLogger('PurchasesArchive');

export async function archivePurchaseBoundary(
  agentId: string | undefined,
  purchaseId: string,
  stage: string,
  value: unknown
): Promise<void> {
  if (agentId === undefined || agentId === '') return;
  try {
    await archiveJson({
      rootAgentId: agentId,
      objectPath: `provider/payment/${purchaseId}.${stage}.json.gz.enc`,
      value,
    });
  } catch (error) {
    log.warn('Purchase provider archive failed', {
      agent_id: agentId,
      purchase_id: purchaseId,
      stage,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
