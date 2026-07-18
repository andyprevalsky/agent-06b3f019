import { Prisma as PrismaRuntime, type Prisma, type ToolSideEffect } from '@prisma/client';
import { prisma } from './database';

export class ToolSideEffectAlreadyStartedError extends Error {
  constructor(public readonly record: ToolSideEffect) {
    super(
      `Side effect '${record.operationKey}' already started without a recorded external id; refusing to repeat it.`
    );
    this.name = 'ToolSideEffectAlreadyStartedError';
  }
}

export type ToolSideEffectClaim =
  { status: 'claimed'; record: ToolSideEffect } | { status: 'existing'; record: ToolSideEffect };
export type ToolSideEffectJson = Prisma.InputJsonValue;

export async function claimToolSideEffect(params: {
  operationKey: string;
  operationType: string;
  request?: ToolSideEffectJson;
}): Promise<ToolSideEffectClaim> {
  try {
    const record = await prisma.toolSideEffect.create({
      data: {
        operationKey: params.operationKey,
        operationType: params.operationType,
        request: params.request,
        status: 'STARTED',
      },
    });
    return { status: 'claimed', record };
  } catch (error) {
    if (error instanceof PrismaRuntime.PrismaClientKnownRequestError && error.code === 'P2002') {
      const record = await prisma.toolSideEffect.findUniqueOrThrow({
        where: { operationKey: params.operationKey },
      });
      return { status: 'existing', record };
    }
    throw error;
  }
}

/** Atomically re-open a provider call that previously failed before acceptance. */
export async function reclaimFailedToolSideEffect(
  operationKey: string
): Promise<ToolSideEffectClaim> {
  const result = await prisma.toolSideEffect.updateMany({
    where: { operationKey, status: 'FAILED' },
    data: { status: 'STARTED', error: null },
  });
  const record = await prisma.toolSideEffect.findUniqueOrThrow({ where: { operationKey } });
  return result.count === 1 ? { status: 'claimed', record } : { status: 'existing', record };
}

export async function markToolSideEffectSucceeded(params: {
  operationKey: string;
  externalId: string;
  response?: ToolSideEffectJson;
}): Promise<ToolSideEffect> {
  return prisma.toolSideEffect.update({
    where: { operationKey: params.operationKey },
    data: {
      status: 'SUCCEEDED',
      externalId: params.externalId,
      response: params.response,
      error: null,
    },
  });
}

export async function markToolSideEffectFailed(params: {
  operationKey: string;
  error: string;
}): Promise<ToolSideEffect> {
  return prisma.toolSideEffect.update({
    where: { operationKey: params.operationKey },
    data: {
      status: 'FAILED',
      error: params.error,
    },
  });
}

export function assertSideEffectCanResume(record: ToolSideEffect): string {
  if (record.externalId !== null && record.externalId !== '') {
    return record.externalId;
  }
  throw new ToolSideEffectAlreadyStartedError(record);
}
