import { prisma } from '../../providers/database';

export async function findToolSideEffectOperationKey(
  operationType: string,
  externalId: string
): Promise<string | null> {
  const record = await prisma.toolSideEffect.findFirst({
    where: { operationType, externalId },
    select: { operationKey: true },
  });
  return record?.operationKey ?? null;
}
