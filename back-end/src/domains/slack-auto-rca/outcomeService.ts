/**
 * Post an auto-RCA agent's result back to its Slack incident thread.
 *
 * Called (via dynamic import) from the agents domain on a root agent's first
 * terminal status. Cost per terminal root agent: one unique-index lookup; only
 * auto-RCA agents do anything more. Never throws.
 */
import { createLogger } from '../../providers/logger';
import { getSlackAutoRcaConfig } from './config';
import { agentLink } from './incidentService';
import * as repo from './repo';
import { postThreadReply, slackEscape } from './slackReplyService';

const log = createLogger('SlackAutoRca');
const MAX_FIELD_CHARS = 1500;

function field(structured: unknown, name: string): string | null {
  if (typeof structured !== 'object' || structured === null) return null;
  const value = (structured as Record<string, unknown>)[name];
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return null;
}

function prLink(structured: unknown): string {
  const url = field(structured, 'pr_url');
  if (url !== null && /^https:\/\/github\.com\/[^\s<>|]+\/pull\/\d+/.test(url)) {
    return `<${url}|${url}>`;
  }
  return 'none opened';
}

export function buildOutcomeText(
  outcome: { status: string; statusMessage: string | null; structuredResponse: unknown },
  feLink: string
): string {
  const icon = outcome.status === 'COMPLETED' ? ':white_check_mark:' : ':x:';
  const lines = [`${icon} RCA agent finished: ${outcome.status}`];
  const summary = field(outcome.structuredResponse, 'summary');
  const rootCause = field(outcome.structuredResponse, 'root_cause');
  const reproduced = field(outcome.structuredResponse, 'reproduced');
  if (summary !== null) lines.push(`*Summary:* ${slackEscape(summary.slice(0, MAX_FIELD_CHARS))}`);
  if (rootCause !== null) {
    lines.push(`*Root cause:* ${slackEscape(rootCause.slice(0, MAX_FIELD_CHARS))}`);
  }
  if (reproduced !== null) lines.push(`*Reproduced locally:* ${reproduced}`);
  if (summary === null && outcome.statusMessage !== null && outcome.statusMessage !== '') {
    lines.push(`*Status:* ${slackEscape(outcome.statusMessage.slice(0, MAX_FIELD_CHARS))}`);
  }
  lines.push(`*PR:* ${prLink(outcome.structuredResponse)}`);
  lines.push(`<${feLink}|Open the RCA agent>`);
  return lines.join('\n');
}

export async function reportSlackAutoRcaOutcome(agentId: string): Promise<boolean> {
  try {
    const incident = await repo.findIncidentByAgentId(agentId);
    if (incident === null) return false;
    const outcome = await repo.findAgentOutcome(agentId);
    if (outcome === null || outcome.parentAgentId !== null) return false;
    const text = buildOutcomeText(outcome, agentLink(getSlackAutoRcaConfig(), agentId));
    return await postThreadReply(incident.slackChannel, incident.slackThreadTs, text);
  } catch (error) {
    log.warn('Slack auto-RCA outcome post failed', {
      agent_id: agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
