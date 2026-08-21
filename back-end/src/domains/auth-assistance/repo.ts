import type { Prisma } from '@prisma/client';
import { randomUUID } from '../../providers/crypto';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import type { CreateAuthAssistanceInput } from './types';

type Tx = Prisma.TransactionClient;

export async function findAgentForUser(agentId: string, userId: string) {
  return prisma.agent.findFirst({
    where: { id: agentId, userId, deletedAt: null },
    select: { id: true, userId: true, temporalWorkflowId: true, source: true },
  });
}

export async function findLatestSessionForAgent(agentId: string, userId: string) {
  return prisma.browserSession.findFirst({
    where: {
      agentId,
      context: { userId },
    },
    include: { context: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function findSessionByBrowserSessionId(
  browserSessionId: string,
  userId: string,
  tx?: Tx
) {
  const client = tx ?? prisma;
  return client.browserSession.findFirst({
    where: {
      id: browserSessionId,
      context: { userId },
    },
    include: { context: true },
  });
}

export async function findSessionBySteelSessionId(steelSessionId: string, userId: string, tx?: Tx) {
  const client = tx ?? prisma;
  return client.browserSession.findFirst({
    where: {
      sessionId: steelSessionId,
      context: { userId },
    },
    include: { context: true },
  });
}

export async function createRequest(
  input: CreateAuthAssistanceInput & {
    userId: string;
    workflowId: string;
    liveViewUrl: string | null;
  }
) {
  const requestId = randomUUID();
  const browserSessionId = input.browserSessionId ?? null;
  const steelSessionId = input.steelSessionId ?? '';
  const metadata = {
    attentionKind: 'auth_assistance',
    authAssistance: {
      requestId,
      authRealm: input.authRealm,
      mode: input.mode,
      browserSessionId,
      steelSessionId,
      browserUrl: input.browserUrl ?? null,
      currentUrl: input.currentUrl ?? null,
      liveViewUrl: input.liveViewUrl,
    },
    requestUserAuthentication: {
      requestId,
      authRealm: input.authRealm,
      browserSessionId,
      steelSessionId,
      handoffMode: input.mode,
      browserUrl: input.browserUrl ?? null,
      liveViewUrl: input.liveViewUrl,
    },
  };

  return runTransactionWithRetry(async (tx) => {
    if (input.currentUrl !== undefined && input.currentUrl !== '') {
      await tx.browserSession.updateMany({
        where: {
          ...(browserSessionId !== null ? { id: browserSessionId } : { sessionId: steelSessionId }),
          context: { userId: input.userId },
        },
        data: { currentUrl: input.currentUrl },
      });
    }

    await tx.agentAttentionRequest.create({
      data: {
        id: requestId,
        userId: input.userId,
        agentId: input.agentId,
        workflowId: input.workflowId,
        question: `Sign in to ${input.authRealm}`,
        metadata,
      },
    });

    return tx.userAuthAssistanceRequest.create({
      data: {
        id: requestId,
        agentId: input.agentId,
        userId: input.userId,
        authRealm: input.authRealm,
        browserSessionId,
        steelSessionId,
        mode: input.mode,
      },
    });
  });
}

export async function findRequestById(id: string) {
  return prisma.userAuthAssistanceRequest.findUnique({
    where: { id },
  });
}

function asJsonObject(value: Prisma.JsonValue | null): Prisma.JsonObject {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return {};
}

function updateNestedAuthMetadata(
  metadata: Prisma.JsonValue | null,
  browserSessionId: string | null,
  steelSessionId: string,
  liveViewUrl: string | null
): Prisma.InputJsonValue {
  const root = { ...asJsonObject(metadata) };
  const authAssistance = { ...asJsonObject(root.authAssistance as Prisma.JsonValue | null) };
  const requestUserAuthentication = {
    ...asJsonObject(root.requestUserAuthentication as Prisma.JsonValue | null),
  };

  root.authAssistance = {
    ...authAssistance,
    browserSessionId,
    steelSessionId,
    liveViewUrl,
  };
  root.requestUserAuthentication = {
    ...requestUserAuthentication,
    browserSessionId,
    steelSessionId,
    liveViewUrl,
  };

  return root as Prisma.InputJsonValue;
}

export async function updateLiveViewHandoff(
  id: string,
  browserSessionId: string | null,
  steelSessionId: string,
  liveViewUrl: string | null
) {
  return prisma.$transaction(async (tx) => {
    const attentionRequest = await tx.agentAttentionRequest.findUnique({
      where: { id },
      select: { metadata: true },
    });

    const metadata = updateNestedAuthMetadata(
      attentionRequest?.metadata ?? null,
      browserSessionId,
      steelSessionId,
      liveViewUrl
    );

    const request = await tx.userAuthAssistanceRequest.update({
      where: { id },
      data: { browserSessionId, steelSessionId },
    });

    await tx.agentAttentionRequest.update({
      where: { id },
      data: { metadata },
    });

    return request;
  });
}
