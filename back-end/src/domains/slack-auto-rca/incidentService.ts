/**
 * Slack auto-RCA incidents: one Rose RCA root agent per error signature window.
 *
 *   alert card ─► claim incident (signature, window) ─► claim Slack event id
 *        │ first card of the window              │ later card, same signature
 *        ▼                                       ▼
 *   create RCA root agent (owner, repo)     append occurrence (bounded) to agent
 *        ▼                                       ▼
 *   thread reply: FE link                   thread reply: FE link of running RCA
 *
 *   thread reply by an allowed reviewer ─► claim event id ─► user message to agent
 *   RCA agent terminal status ─► summary + PR + FE link in the incident thread
 *
 * Idempotency: Slack redelivers events. The event id row dedupes deliveries and
 * the incident's pre-minted agent id makes creation retry-safe. A failed side
 * effect releases its claim and surfaces an error so Slack retries the event.
 */
import { randomUUID } from '../../providers/crypto';
import { normalizeGithubUrl } from '../../providers/github';
import { createLogger } from '../../providers/logger';
import { getSlackAutoRcaConfig, MAX_APPENDED_OCCURRENCES, type SlackAutoRcaConfig } from './config';
import {
  buildFeedbackMessage,
  buildOccurrenceMessage,
  buildRcaGoal,
  RCA_RESPONSE_SCHEMA,
} from './rcaGoalService';
import * as repo from './repo';
import { errorSignature, mentionedAgentIds } from './service';
import { addReaction, postThreadReply } from './slackReplyService';
import type {
  SlackAutoRcaErrorAlert,
  SlackAutoRcaFeedback,
  SlackAutoRcaIncidentRow,
  SlackAutoRcaOutcome,
} from './types';

const log = createLogger('SlackAutoRca');

/** The webhook must answer non-2xx so Slack redelivers once this is fixed. */
export class SlackAutoRcaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackAutoRcaError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function agentLink(cfg: SlackAutoRcaConfig, agentId: string): string {
  return `${cfg.frontendBaseUrl}/?agent-id=${agentId}`;
}

function requireOwner(cfg: SlackAutoRcaConfig): { ownerUserId: string; repoUrl: string } {
  if (cfg.ownerUserId === '') {
    throw new SlackAutoRcaError('SLACK_AUTO_RCA_OWNER_USER_ID is not configured');
  }
  const repoUrl = normalizeGithubUrl(cfg.repoUrl);
  if (repoUrl === null) {
    throw new SlackAutoRcaError(`SLACK_AUTO_RCA_REPO_URL is not a GitHub URL: ${cfg.repoUrl}`);
  }
  return { ownerUserId: cfg.ownerUserId, repoUrl };
}

function windowStartFor(messageTs: string, windowMs: number): Date {
  const ms = Number(messageTs.split('.')[0]) * 1000;
  return new Date(Math.floor(ms / windowMs) * windowMs);
}

async function startRcaAgent(
  incident: SlackAutoRcaIncidentRow,
  alert: SlackAutoRcaErrorAlert,
  owner: { ownerUserId: string; repoUrl: string }
): Promise<void> {
  // Dynamic import keeps the agents and slack-auto-rca domains decoupled.
  const [{ createAgent }, { createAgentSchema }] = await Promise.all([
    import('../agents/agentLifecycleService'),
    import('../agents/types'),
  ]);
  const body = createAgentSchema.parse({
    agent_id: incident.agentId,
    goal: buildRcaGoal(alert, owner.repoUrl),
    start_phase: 'plan',
    response_schema: RCA_RESPONSE_SCHEMA,
  });
  // isInternal=false: alert text must never resolve {{PROMPT_SECRET}} templates.
  await createAgent(body, owner.ownerUserId, false, null, false, { githubRepoUrl: owner.repoUrl });
}

/** Create the incident's RCA agent unless it already exists. */
async function ensureRcaAgent(
  incident: SlackAutoRcaIncidentRow,
  alert: SlackAutoRcaErrorAlert,
  cfg: SlackAutoRcaConfig
): Promise<void> {
  if (await repo.agentExists(incident.agentId)) return;
  const owner = requireOwner(cfg);
  if (!(await repo.findUserExists(owner.ownerUserId))) {
    throw new SlackAutoRcaError(`Auto-RCA owner user ${owner.ownerUserId} does not exist`);
  }
  await repo.ensureGithubRepoAccess(owner.ownerUserId, owner.repoUrl);
  try {
    await startRcaAgent(incident, alert, owner);
    log.info('Created Slack auto-RCA agent', {
      agent_id: incident.agentId,
      incident_id: incident.id,
      slack_ts: alert.messageTs,
    });
  } catch (error) {
    // A concurrent delivery created the same pre-minted agent id first.
    if (repo.isUniqueViolation(error) && (await repo.agentExists(incident.agentId))) return;
    const message = `Failed to start the auto-RCA agent: ${errorMessage(error)}`;
    if (await repo.agentExists(incident.agentId)) {
      await repo.markAgentStartFailed(incident.agentId, message);
      await repo.rotateIncidentAgent(incident.id, incident.agentId, randomUUID());
    }
    throw new SlackAutoRcaError(message);
  }
}

async function notifyStarted(incident: SlackAutoRcaIncidentRow, cfg: SlackAutoRcaConfig) {
  if (!(await repo.claimStartNotification(incident.id))) return;
  const posted = await postThreadReply(
    incident.slackChannel,
    incident.slackThreadTs,
    `:mag: Rose is root-causing this error on ${cfg.repoUrl}. <${agentLink(cfg, incident.agentId)}|Open the RCA agent>`
  );
  // Leave the reply to the next delivery of this incident instead of losing it.
  if (!posted) await repo.releaseStartNotification(incident.id);
}

async function appendOccurrence(
  incident: SlackAutoRcaIncidentRow,
  alert: SlackAutoRcaErrorAlert,
  cfg: SlackAutoRcaConfig
): Promise<SlackAutoRcaOutcome> {
  const ids = { agentId: incident.agentId, incidentId: incident.id };
  await ensureRcaAgent(incident, alert, cfg);
  await notifyStarted(incident, cfg);
  if (!(await repo.recordOccurrence(incident.id, MAX_APPENDED_OCCURRENCES))) {
    return { action: 'counted', ...ids };
  }
  try {
    await deliverToAgent(incident, buildOccurrenceMessage(alert), { slackTs: alert.messageTs });
  } catch (error) {
    await repo.releaseAppendSlot(incident.id);
    throw error;
  }
  await postThreadReply(
    alert.channel,
    alert.messageTs,
    `:link: Same error as an RCA already running. Added to <${agentLink(cfg, incident.agentId)}|its agent>.`
  );
  return { action: 'appended', ...ids };
}

async function deliverToAgent(
  incident: SlackAutoRcaIncidentRow,
  message: string,
  metadata: Record<string, string>
): Promise<void> {
  const { postMessage } = await import('../agents/agentMessageService');
  const result = await postMessage(
    incident.agentId,
    { message, metadata: { source: 'slack_auto_rca', ...metadata } },
    false,
    incident.ownerUserId
  );
  if ('error' in result) {
    throw new SlackAutoRcaError(
      `RCA agent ${incident.agentId} rejected a message: ${result.error}`
    );
  }
}

/** Handle a top-level error card in the Slack error channel. */
export async function handleErrorAlert(
  alert: SlackAutoRcaErrorAlert
): Promise<SlackAutoRcaOutcome> {
  const cfg = getSlackAutoRcaConfig();
  if (!cfg.enabled) {
    log.info('AUTO_RCA_ENABLED is not 1; not starting an RCA for this error card', {
      slack_ts: alert.messageTs,
    });
    return { action: 'ignored', reason: 'auto_rca_disabled' };
  }
  const owner = requireOwner(cfg);
  if (await repo.anyAgentOwnedByRcaIncident(mentionedAgentIds(alert.report))) {
    log.error('An auto-RCA agent failed; not starting an RCA of the RCA', {
      slack_ts: alert.messageTs,
    });
    return { action: 'ignored', reason: 'rca_agent_failure' };
  }
  const { incident } = await repo.claimIncident({
    signature: errorSignature(alert.text),
    windowStart: windowStartFor(alert.messageTs, cfg.signatureWindowMs),
    agentId: randomUUID(),
    ownerUserId: owner.ownerUserId,
    slackChannel: alert.channel,
    slackThreadTs: alert.messageTs,
  });
  const isOrigin =
    incident.slackChannel === alert.channel && incident.slackThreadTs === alert.messageTs;
  const claimed = await repo.claimEvent({
    eventId: alert.eventId,
    incidentId: incident.id,
    kind: isOrigin ? 'error' : 'occurrence',
    slackChannel: alert.channel,
    slackTs: alert.messageTs,
  });
  const ids = { agentId: incident.agentId, incidentId: incident.id };
  if (!isOrigin && !claimed) return { action: 'duplicate', ...ids };
  try {
    if (!isOrigin) return await appendOccurrence(incident, alert, cfg);
    // Redeliveries of the origin card re-run creation: it is idempotent and
    // finishes a creation whose first attempt died part-way.
    await ensureRcaAgent(incident, alert, cfg);
  } catch (error) {
    if (claimed) await repo.releaseEvent(alert.eventId);
    throw error;
  }
  await notifyStarted(incident, cfg);
  return claimed ? { action: 'created', ...ids } : { action: 'duplicate', ...ids };
}

/** Handle a reviewer reply inside an alert thread. */
export async function handleFeedback(feedback: SlackAutoRcaFeedback): Promise<SlackAutoRcaOutcome> {
  const cfg = getSlackAutoRcaConfig();
  if (!cfg.feedbackUserIds.has(feedback.userId)) {
    log.warn('Ignoring Slack RCA feedback from a user not in SLACK_AUTO_RCA_FEEDBACK_USER_IDS', {
      user_id: feedback.userId,
    });
    return { action: 'ignored', reason: 'feedback_user_not_allowed' };
  }
  const incident = await repo.findIncidentByAlertMessage(feedback.channel, feedback.threadTs);
  if (incident === null) return { action: 'ignored', reason: 'unknown_thread' };
  const ids = { agentId: incident.agentId, incidentId: incident.id };
  const claimed = await repo.claimEvent({
    eventId: feedback.eventId,
    incidentId: incident.id,
    kind: 'feedback',
    slackChannel: feedback.channel,
    slackTs: feedback.messageTs,
  });
  if (!claimed) return { action: 'duplicate', ...ids };
  try {
    await deliverToAgent(incident, buildFeedbackMessage(feedback), {
      slackTs: feedback.messageTs,
      slackUserId: feedback.userId,
    });
  } catch (error) {
    await repo.releaseEvent(feedback.eventId);
    throw error;
  }
  await addReaction(feedback.channel, feedback.messageTs, 'eyes');
  return { action: 'feedback', ...ids };
}
