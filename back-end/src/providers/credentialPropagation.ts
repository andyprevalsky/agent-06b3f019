/**
 * Provider-level post-run credential propagation.
 *
 * Browser-run completion + Message.credential_ref
 *   -> classify failed run
 *   -> one idempotency marker per browser run
 *   -> credential liveness updates + visible terminal-failure surface
 */

import type { AgentStatus, Prisma } from '@prisma/client';
import {
  aggregateDecision,
  buildCredentialClassifierSystemPrompt,
  buildCredentialClassifierUserPrompt,
  classifyCredentialOutcomesBestEffort,
  classifyFailureBestEffort,
  extractCredentialRefs,
  rawFailureText,
  type AgentForPropagation,
  type CredentialKind,
  type CredentialPropagationDecision,
  type CredentialPropagationOutcome,
  type CredentialRef,
  type FailureReason,
  type PropagationDecision,
} from './credentialPropagationClassifier';
import { prisma } from './database';
import { createLogger } from './logger';
import { createMessage } from './messages';
import { saveMintedPasswordlessLogin } from './mintedAccountPassword';

export {
  buildCredentialClassifierSystemPrompt,
  buildCredentialClassifierUserPrompt,
  extractCredentialRefs,
};

const log = createLogger('CredentialPropagation');

const TERMINAL_STATUSES = new Set<AgentStatus>([
  'COMPLETED',
  'FAILED',
  'OUT_OF_CREDITS',
  'COST_LIMIT_REACHED',
]);

function disableData(decision: PropagationDecision) {
  if (decision.outcome === 'success') {
    return { disabledAt: null, disabledReason: null };
  }

  const stableReason = decision.failureReason ?? decision.outcome;
  const reasonParts: string[] = [stableReason];
  if (decision.reason !== '' && decision.reason !== stableReason) {
    reasonParts.push(decision.reason);
  }
  if (decision.rawError !== null && decision.rawError !== '') {
    reasonParts.push(decision.rawError.slice(0, 4000));
  }
  const disabledReason = reasonParts.join(': ');

  if (decision.outcome === 'auth_failed') {
    return { disabledAt: new Date(), disabledReason };
  }

  return { disabledReason };
}

async function applyCredentialDecision(
  tx: Prisma.TransactionClient,
  credentialRef: CredentialRef,
  decision: PropagationDecision
): Promise<void> {
  if (
    decision.outcome === 'unused' ||
    decision.outcome === 'task_level' ||
    decision.outcome === 'unknown'
  ) {
    return;
  }

  if (credentialRef.kind === 'email_otp') {
    if (decision.outcome !== 'success') return;
    const now = new Date();
    await tx.$executeRaw`
      UPDATE "EmailIntegrationCredential"
      SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('lastUsedAt', ${now.toISOString()}),
          "updatedAt" = ${now}
      WHERE id = ${credentialRef.id}
    `;
    return;
  }

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
      if (decision.outcome === 'auth_failed') {
        const auth = await tx.steelSessionAuth.findUnique({
          where: { id: credentialRef.id },
          select: { userId: true, contextId: true, authRealm: true },
        });
        if (auth !== null) {
          await tx.browserContext.updateMany({
            where: { userId: auth.userId, contextId: auth.contextId },
            data: { contextId: null },
          });
          log.info('Reset Steel persistent context after auth failure', {
            user_id: auth.userId,
            auth_realm: auth.authRealm,
          });
        }
      }
      return;
    case 'minted': {
      await tx.mintedAccount.updateMany({ where: { id: credentialRef.id }, data });
      if (decision.outcome !== 'success' || !credentialRef.username || !credentialRef.origin)
        return;
      const minted = await tx.mintedAccount.findUnique({
        where: { id: credentialRef.id },
        select: { userId: true },
      });
      if (minted === null) return;
      await saveMintedPasswordlessLogin(tx, {
        userId: minted.userId,
        origin: credentialRef.origin,
        username: credentialRef.username,
        nowMs: Date.now(),
      });
      return;
    }
    case 'passkey':
      // auth_failed here means the relying party rejected our stored passkey
      // (revoked, counter mismatch) -> disable so auth-options stops surfacing it.
      await tx.passkeyCredential.updateMany({ where: { id: credentialRef.id }, data });
      return;
  }
}

async function tryCreatePropagationMarker(
  tx: Prisma.TransactionClient,
  agentId: string
): Promise<boolean> {
  try {
    await tx.agentRunCredentialPropagation.create({
      data: { agentId },
    });
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    ) {
      return false;
    }
    throw error;
  }
}

async function propagateCredentialInTransaction(
  markerId: string,
  decisions: CredentialPropagationDecision[]
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const created = await tryCreatePropagationMarker(tx, markerId);
    if (!created) return false;
    for (const decision of decisions) {
      await applyCredentialDecision(tx, decision.credentialRef, decision);
    }
    return true;
  });
}

async function surfaceFailureDecision(
  agent: AgentForPropagation,
  decision: PropagationDecision,
  options: { suppressVisibleFailureSurface?: boolean } = {}
): Promise<void> {
  if (options.suppressVisibleFailureSurface === true) return;
  if (decision.outcome === 'success') return;
  if (decision.rawError === null || decision.rawError === '') return;

  await createMessage({
    agentId: agent.id,
    role: 'TOOL',
    text: `Browser run failed.\n\nFailure reason: ${decision.failureReason ?? 'unknown'}\n\nRaw error: ${decision.rawError}`,
    metadata: {
      toolCallId: `credential_failure_classifier:${agent.id}`,
      toolName: 'credential_failure_classifier',
      toolStatus: 'FINISHED',
      title: 'Browser Failure Classified',
      action_type: 'credential_failure_classification',
      rawError: decision.rawError,
      failureReason: decision.failureReason,
      credentialPropagationOutcome: decision.outcome,
    },
  });
}

function appliedDecisionCount(
  didApply: boolean,
  decisions: CredentialPropagationDecision[]
): number {
  if (!didApply) return 0;
  return decisions.filter(
    (credentialDecision) =>
      !['unused', 'task_level', 'unknown'].includes(credentialDecision.outcome)
  ).length;
}

export async function classifyAgentFailureForSurface(
  agentId: string
): Promise<PropagationDecision | null> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, userId: true, goal: true, status: true, statusMessage: true },
  });
  if (agent === null || !TERMINAL_STATUSES.has(agent.status)) return null;

  const messages = await prisma.message.findMany({
    where: { agentId },
    orderBy: { timestamp: 'asc' },
    select: { role: true, text: true, metadata: true, timestamp: true },
  });
  const credentialRefs = extractCredentialRefs(messages);
  return classifyFailureBestEffort(agent, messages, credentialRefs);
}

export async function propagatePostRunCredentials(
  agentId: string
): Promise<PropagationDecision | null> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, userId: true, goal: true, status: true, statusMessage: true },
  });
  if (agent === null || !TERMINAL_STATUSES.has(agent.status)) return null;

  const messages = await prisma.message.findMany({
    where: { agentId },
    orderBy: { timestamp: 'asc' },
    select: { role: true, text: true, metadata: true, timestamp: true },
  });
  const credentialRefs = extractCredentialRefs(messages);
  if (credentialRefs.length === 0) {
    log.info('Post-run credential propagation skipped; no credential refs observed', {
      agent_id: agentId,
      status: agent.status,
      refs: 0,
      applied: 0,
    });
    return null;
  }

  const classification = await classifyCredentialOutcomesBestEffort(
    agent,
    messages,
    credentialRefs
  );
  const decision = aggregateDecision(classification.decisions, classification.reason);
  const didApply = await propagateCredentialInTransaction(agentId, classification.decisions);
  if (didApply) {
    await surfaceFailureDecision(agent, decision);
  }

  log.info('Post-run credential propagation complete', {
    agent_id: agentId,
    status: agent.status,
    outcome: decision.outcome,
    refs: credentialRefs.length,
    applied: appliedDecisionCount(didApply, classification.decisions),
  });

  return decision;
}

export async function propagateBrowserRunCredentials({
  agentId,
  taskId,
  success,
  status,
  message,
}: {
  agentId: string;
  taskId: string;
  success: boolean;
  status: string;
  message: string;
}): Promise<
  | (PropagationDecision & {
      refs: number;
      applied: number;
      credentialOutcomes: Array<{
        reason: string;
        kind: CredentialKind;
        id: string;
        outcome: CredentialPropagationOutcome;
        failureReason: FailureReason | null;
      }>;
    })
  | null
> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, userId: true, goal: true },
  });
  if (agent === null) return null;

  const messages = await prisma.message.findMany({
    where: {
      agentId,
      OR: [
        { metadata: { path: ['task_id'], equals: taskId } },
        { metadata: { path: ['subAgentId'], equals: taskId } },
      ],
    },
    orderBy: { timestamp: 'asc' },
    select: { role: true, text: true, metadata: true, timestamp: true },
  });
  const credentialRefs = extractCredentialRefs(messages);
  const syntheticAgent: AgentForPropagation = {
    id: agent.id,
    userId: agent.userId,
    goal: agent.goal,
    status: success ? 'COMPLETED' : 'FAILED',
    statusMessage: message !== '' ? message : status,
  };

  if (credentialRefs.length === 0) {
    const decision: PropagationDecision = {
      outcome: success ? 'success' : 'task_level',
      reason: 'no_credentials_used',
      rawError: success ? null : rawFailureText(syntheticAgent, messages),
      failureReason: success ? null : 'task_level',
    };
    log.info('Browser-run credential propagation skipped; no credential refs observed', {
      agent_id: agentId,
      task_id: taskId,
      status,
      outcome: decision.outcome,
      refs: 0,
      applied: 0,
    });
    return {
      ...decision,
      refs: 0,
      applied: 0,
      credentialOutcomes: [],
    };
  }

  const classification = await classifyCredentialOutcomesBestEffort(
    syntheticAgent,
    messages,
    credentialRefs
  );
  const decision = aggregateDecision(classification.decisions, classification.reason);
  const markerId = `${agentId}:browser:${taskId}`;
  const didApply = await propagateCredentialInTransaction(markerId, classification.decisions);
  if (didApply) {
    await surfaceFailureDecision(syntheticAgent, decision, {
      suppressVisibleFailureSurface: status === 'awaiting_auth_assistance',
    });
  }
  const applied = appliedDecisionCount(didApply, classification.decisions);

  log.info('Browser-run credential propagation complete', {
    agent_id: agentId,
    task_id: taskId,
    status,
    outcome: decision.outcome,
    refs: credentialRefs.length,
    applied,
  });

  return {
    ...decision,
    refs: credentialRefs.length,
    applied,
    credentialOutcomes: classification.decisions.map((credentialDecision) => ({
      reason: credentialDecision.reason,
      kind: credentialDecision.credentialRef.kind,
      id: credentialDecision.credentialRef.id,
      outcome: credentialDecision.outcome,
      failureReason: credentialDecision.failureReason,
    })),
  };
}
