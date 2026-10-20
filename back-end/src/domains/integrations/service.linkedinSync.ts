/**
 * LinkedIn export sync state.
 *
 *   [NOT_CONNECTED] --startLinkedInSync(agent)--> [SYNCING {syncAgentId}]
 *   [SYNCING {syncAgentId}] --agent uploads export--> upload flow --> [CONNECTED | SYNC_FAILED]
 *   [SYNCING {syncAgentId}] --agent ends without uploading--> read as [SYNC_FAILED]
 *   [SYNCING {syncAgentId}] --chat never started its workflow (grace over)--> read as [SYNC_FAILED]
 *
 * The export agent is an ordinary agent; this row only remembers which agent
 * owns the sync so every client (and every refresh) reads the same state.
 */

import { upsertIntegrationForUpload } from './repo';
import * as repo from './repo.linkedinSync';
import { IntegrationStatus } from './types';

export const LINKEDIN_INTEGRATION_NAME = 'linkedin';

/** Agent states in which the export can still arrive. */
const LIVE_AGENT_STATUSES = new Set(['STARTING_UP', 'ACTIVE', 'PAUSED']);

/**
 * A new agent is a chat agent until its router escalates (seconds). One that
 * still has no workflow after this window answered in chat or failed there,
 * and an idle chat agent stays ACTIVE forever — it will never upload.
 */
export const LINKEDIN_SYNC_START_GRACE_MS = 2 * 60_000;

type AgentLifecycle = NonNullable<Awaited<ReturnType<typeof repo.findOwnedAgentLifecycle>>>;

function canStillUpload(agent: AgentLifecycle | null, now: number): boolean {
  if (agent === null || agent.deletedAt !== null || !LIVE_AGENT_STATUSES.has(agent.status)) {
    return false;
  }
  return (
    agent.temporalWorkflowId !== null ||
    now - agent.createdAt.getTime() < LINKEDIN_SYNC_START_GRACE_MS
  );
}

export class LinkedInSyncAlreadyRunningError extends Error {
  constructor(public readonly agentId: string) {
    super(`LinkedIn sync already running with agent ${agentId}`);
    this.name = 'LinkedInSyncAlreadyRunningError';
  }
}

export class LinkedInSyncAgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent ${agentId} not found`);
    this.name = 'LinkedInSyncAgentNotFoundError';
  }
}

/** Record `agentId` as the user's LinkedIn export agent and mark the sync running. */
export async function startLinkedInSync(userId: string, agentId: string) {
  const agent = await repo.findOwnedAgentLifecycle(agentId, userId);
  if (agent === null) throw new LinkedInSyncAgentNotFoundError(agentId);
  const existing = await repo.findLinkedInIntegration(userId);
  const runningAgentId =
    existing?.status === IntegrationStatus.SYNCING ? syncAgentIdOf(existing.config) : null;
  if (runningAgentId !== null && runningAgentId !== agentId) {
    const running = await repo.findOwnedAgentLifecycle(runningAgentId, userId);
    if (canStillUpload(running, Date.now()))
      throw new LinkedInSyncAlreadyRunningError(runningAgentId);
  }
  const integration = await upsertIntegrationForUpload({
    userId,
    name: LINKEDIN_INTEGRATION_NAME,
    config: { syncAgentId: agentId, startedAt: new Date().toISOString() },
  });
  return { integration_id: integration.id, status: integration.status, agent_id: agentId };
}

function syncAgentIdOf(config: unknown): string | null {
  if (typeof config !== 'object' || config === null) return null;
  const id = (config as { syncAgentId?: unknown }).syncAgentId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * A running LinkedIn sync whose export agent already ended (finished, failed,
 * archived, or never left chat) without uploading reads as SYNC_FAILED, so the row stops
 * showing "Connecting" and the user can start a new export.
 */
export async function settleLinkedInSync<
  T extends {
    name: string;
    status: IntegrationStatus;
    config: unknown;
    failureReason: string | null;
  },
>(userId: string, integrations: T[]): Promise<T[]> {
  return Promise.all(
    integrations.map(async (integration) => {
      if (
        integration.name !== LINKEDIN_INTEGRATION_NAME ||
        integration.status !== IntegrationStatus.SYNCING
      ) {
        return integration;
      }
      const agentId = syncAgentIdOf(integration.config);
      if (agentId === null) return integration;
      const agent = await repo.findOwnedAgentLifecycle(agentId, userId);
      if (canStillUpload(agent, Date.now())) return integration;
      return {
        ...integration,
        status: IntegrationStatus.SYNC_FAILED,
        failureReason: 'The LinkedIn export agent ended before uploading the export',
      };
    })
  );
}
