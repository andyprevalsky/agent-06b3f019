/**
 * C15: a code agent stopped on a provider usage limit and must resume on the
 * next available credential (or the other provider) from its saved session.
 *
 *   agents activity ─ structured limit event (rate_limit_event rejected /
 *   │                 Codex codex_error_info usage_limit_exceeded)
 *   ├─ POST /:taskId/usage-limit ──► markCodeTaskUsageLimited
 *   │     the task's credential row gets rateLimitedUntil (pool / user
 *   │     integration) or the shared funded key goes on cooldown — the same
 *   │     markers and columns the credential pools already read
 *   ├─ GET /credential-availability ──► codeCredentialAvailability
 *   │     is any Claude / Codex credential leasable right now (count queries,
 *   │     no decrypt, no lease)
 *   └─ retry spawn with code_session_id ──► switchCodeSessionProvider when the
 *         provider changed: the new provider restores the checkpoint (same
 *         branch, commits, files) and gets a handoff summary of the transcript
 *
 * 10k agents: per call one indexed session read plus at most two count
 * queries; no shared row is written except the exhausted credential itself.
 */
import { prisma } from '../database';
import { createLogger } from '../logger';
import { markPoolTokenRateLimited, markUserTokenRateLimited } from '../claudeCredentials';
import { isAnthropicApiKeyOnCooldown, markAnthropicApiKeyOnCooldown } from '../computeCredentials';
import {
  isGptApiKeyOnCooldown,
  markGptApiKeyOnCooldown,
  markGptIntegrationRateLimited,
} from '../gptCredentials';
import { checkpointKey, getCheckpointObject } from './artifactStore';
import { CLI_LOG_ARTIFACT } from './checkpoint';
import { excerpt, parseCodeEvents } from './codeEvents';
import type { CodeSessionRow } from './store';

const log = createLogger('CodeSessionUsageLimit');

export type CodeProvider = 'claude' | 'codex';

/** Seconds, milliseconds or an ISO string → Date; null when absent or invalid. */
export function parseResetsAt(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** Mark the credential the task ran on as rate-limited until the reset. */
export async function markCodeTaskUsageLimited(
  taskId: string,
  provider: CodeProvider,
  resetsAt: Date | null
): Promise<{ marked: string | null }> {
  const task = await prisma.claudeCodeSession.findUnique({
    where: { id: taskId },
    select: { agentId: true, claudeTokenSource: true, claudeTokenIntegrationId: true },
  });
  if (task === null) return { marked: null };
  const source = task.claudeTokenSource ?? '';
  const integrationId = task.claudeTokenIntegrationId ?? '';
  const until = resetsAt ?? undefined;
  if (provider === 'codex') {
    if (integrationId !== '') {
      await markGptIntegrationRateLimited(integrationId, { rateLimitedUntil: until });
      return { marked: `gpt_integration:${integrationId}` };
    }
    await markGptApiKeyOnCooldown('codex_code_usage_limit');
    return { marked: 'gpt_api_key' };
  }
  if (source === 'pool' && integrationId !== '') {
    await markPoolTokenRateLimited(integrationId, { rateLimitedUntil: until });
    return { marked: `claude_pool:${integrationId}` };
  }
  if (source === 'user') {
    const agent = await prisma.agent.findUnique({
      where: { id: task.agentId },
      select: { userId: true },
    });
    if (agent !== null) {
      await markUserTokenRateLimited(agent.userId, {
        rateLimitedUntil: until,
        ...(integrationId !== '' ? { integrationId } : {}),
      });
      return { marked: `claude_user:${agent.userId}` };
    }
  }
  await markAnthropicApiKeyOnCooldown('claude_code_rate_limit');
  return { marked: 'anthropic_api_key' };
}

async function hasLeasableIntegration(userId: string, name: string, now: Date): Promise<boolean> {
  const notLimited = [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }];
  const own = await prisma.integration.count({
    where: { userId, name, status: 'CONNECTED', OR: notLimited },
  });
  if (own > 0) return true;
  const pooled = await prisma.integration.count({
    where: { name, status: 'CONNECTED', poolingEnabled: true, OR: notLimited },
  });
  return pooled > 0;
}

/** Whether a spawn could lease a Claude / Codex credential right now. */
export async function codeCredentialAvailability(
  userId: string,
  now = new Date()
): Promise<Record<CodeProvider, boolean>> {
  const claude =
    (await hasLeasableIntegration(userId, 'claude_code', now)) ||
    (Boolean(process.env.ANTHROPIC_API_KEY) && !(await isAnthropicApiKeyOnCooldown()));
  const codex =
    (await hasLeasableIntegration(userId, 'gpt_code', now)) ||
    (Boolean(process.env.GPT_API_KEY) && !(await isGptApiKeyOnCooldown()));
  return { claude, codex };
}

const HANDOFF_EVENTS = 15;

/** Short factual summary of what the previous provider's CLI did (no prose classifier). */
export async function buildProviderHandoff(session: CodeSessionRow): Promise<string> {
  const lines: string[] = [];
  if (session.latestCheckpointSeq > 0) {
    const key = checkpointKey(
      session.userId,
      session.id,
      session.latestCheckpointSeq,
      CLI_LOG_ARTIFACT
    );
    const cliLog = await getCheckpointObject(key).catch(() => null);
    if (cliLog !== null) {
      for (const event of parseCodeEvents(session.codeProvider, cliLog).slice(-HANDOFF_EVENTS)) {
        lines.push(
          event.command !== undefined
            ? `- ran \`${excerpt(event.command, 200)}\` (exit ${event.exitCode ?? 'unknown'})`
            : `- edited ${event.editedFile ?? 'a file'}`
        );
      }
    }
  }
  const previous = session.codeProvider === 'codex' ? 'Codex' : 'Claude Code';
  return [
    `Handoff: ${previous} worked on this task before you and stopped at a provider usage limit.`,
    'Its commits and uncommitted files are already in your workspace' +
      (session.branch !== null ? ` on branch \`${session.branch}\`` : '') +
      '. Continue from that state; do not start over.',
    ...(lines.length > 0 ? ['Its last actions:', ...lines] : []),
  ].join('\n');
}

/**
 * A retry on the other provider: forget the paused sandbox (it runs the other
 * CLI's template) so the new sandbox restores the latest checkpoint, and drop
 * the other CLI's conversation id. Returns the handoff summary for the goal.
 */
export async function switchCodeSessionProvider(
  session: CodeSessionRow,
  provider: CodeProvider,
  killSandbox: (sandboxId: string) => Promise<void>
): Promise<{ session: CodeSessionRow; handoff: string }> {
  const handoff = await buildProviderHandoff(session);
  if (session.sandboxKind === 'e2b' && session.sandboxId !== null) {
    await killSandbox(session.sandboxId).catch((error: unknown) => {
      log.warn('Retiring the previous provider sandbox failed', {
        codeSessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  const updated = await prisma.codeSession.update({
    where: { id: session.id },
    data: { codeProvider: provider, cliSessionId: null, sandboxKind: null, sandboxId: null },
  });
  log.info('Code session continues on another provider', {
    codeSessionId: session.id,
    from: session.codeProvider,
    to: provider,
    checkpointSeq: String(session.latestCheckpointSeq),
  });
  return { session: updated, handoff };
}
