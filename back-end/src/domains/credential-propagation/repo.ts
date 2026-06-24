import type { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import type { AgentForPropagation, CredentialRef, PropagationDecision } from './types';

type Tx = Prisma.TransactionClient;

export async function loadAgentForPropagation(
  agentId: string
): Promise<AgentForPropagation | null> {
  return prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, goal: true, status: true, statusMessage: true },
  });
}

export async function loadMessagesForPropagation(agentId: string) {
  return prisma.message.findMany({
    where: { agentId },
    orderBy: { timestamp: 'asc' },
    select: { role: true, text: true, metadata: true },
  });
}

function markerId(agentId: string, credentialRef: CredentialRef): string {
  return `${agentId}:${credentialRef.kind}:${credentialRef.id}`;
}

export async function tryCreatePropagationMarker(
  tx: Tx,
  agentId: string,
  credentialRef: CredentialRef
): Promise<boolean> {
  const result = await tx.agentRunCredentialPropagation.createMany({
    data: [{ agentId: markerId(agentId, credentialRef) }],
    skipDuplicates: true,
  });
  return result.count === 1;
}

function disableData(decision: PropagationDecision) {
  if (decision.outcome === 'success') {
    return { disabledAt: null, disabledReason: null };
  }

  const reasonParts = [decision.reason];
  if (decision.rawError !== null && decision.rawError !== '') {
    reasonParts.push(decision.rawError.slice(0, 4000));
  }
  const disabledReason = reasonParts.join(': ');

  if (decision.outcome === 'auth_failed') {
    return { disabledAt: new Date(), disabledReason };
  }

  return { disabledReason };
}

export async function applyCredentialDecision(
  tx: Tx,
  credentialRef: CredentialRef,
  decision: PropagationDecision
): Promise<void> {
  const data = disableData(decision);

  switch (credentialRef.kind) {
    case 'cookie_bundle':
      await tx.cookieBundle.updateMany({ where: { id: credentialRef.id }, data });
      return;
    case 'password':
      await tx.browserPassword.updateMany({ where: { id: credentialRef.id }, data });
      return;
    case 'steel_session':
      await tx.steelSessionAuth.updateMany({ where: { id: credentialRef.id }, data });
      return;
    case 'minted':
      await tx.mintedAccount.updateMany({ where: { id: credentialRef.id }, data });
      return;
    case 'passkey':
      // Relying party rejected our stored passkey (revoked / counter mismatch)
      // -> disable so auth-options stops surfacing it.
      await tx.passkeyCredential.updateMany({ where: { id: credentialRef.id }, data });
      return;
  }
}

export async function propagateCredentialInTransaction(
  agentId: string,
  credentialRef: CredentialRef,
  decision: PropagationDecision
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const created = await tryCreatePropagationMarker(tx, agentId, credentialRef);
    if (!created) return false;
    await applyCredentialDecision(tx, credentialRef, decision);
    return true;
  });
}
