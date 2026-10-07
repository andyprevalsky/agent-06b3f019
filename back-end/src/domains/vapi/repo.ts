import { findToolSideEffectOperationKey as findProviderOperationKey } from '../../providers/vapiRecordings';

export async function findToolSideEffectOperationKey(
  operationType: string,
  externalId: string
): Promise<string | null> {
  return findProviderOperationKey(operationType, externalId);
}
