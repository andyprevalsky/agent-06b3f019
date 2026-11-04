/**
 * Codex credential feedback from a finished run's terminal output (persistOutput):
 * mark the exact credential each observed failure belongs to — the ChatGPT login
 * the task leased, or the funded Azure deployment once the sandbox switched to it.
 */
import * as repo from './repo';
import { createLogger } from '../../providers/logger';
import {
  markGptIntegrationRateLimited,
  markGptUserTokenRateLimited,
} from '../../providers/gptCredentials';
import { markCodexFundedCooldown } from '../../providers/codeSessions/usageLimit';
import { classifyComputeGrantFailure } from '../../providers/computeGrantFailure';

const log = createLogger('CodexCode');

/** The exact terminal line ws-server prints when it switches a run to the funded Azure deployment. */
export const CODEX_AZURE_SWITCH_LINE =
  '[Codex] ChatGPT OAuth unusable — continuing on the funded Azure OpenAI deployment';

export type CodexCredentialFeedback = {
  source: 'initial' | 'oauth' | 'funded_api_key';
  reason: string;
};

function parseCodexResetTime(output: string): Date | null {
  const match = output.match(
    /try again at\s+([A-Z][a-z]{2}\s+\d{1,2}(?:st|nd|rd|th)?,\s+\d{4}\s+\d{1,2}:\d{2}\s+(?:AM|PM))/i
  );
  if (match === null) return null;
  const parsed = new Date(`${match[1].replace(/(\d{1,2})(?:st|nd|rd|th)/i, '$1')} UTC`);
  return Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now() ? null : parsed;
}

function isRevokedCodexOAuth(reason: string): boolean {
  return (
    reason.trim() === 'oauth_refresh_invalid' ||
    classifyComputeGrantFailure({ status: 401, body: reason }).verdict === 'revoked'
  );
}

function isCodexExhaustion(reason: string): boolean {
  const exhausted =
    /You've hit your usage limit|usage[ _]limit|usage_limit_reached|purchase more credits|Quota exceeded\.\s*Check your plan and billing details|insufficient[_ ]quota|check your plan and billing|no credits remaining|add credits to continue|credit[_ ]balance[_ ]exhausted|credit balance is too low/i;
  return (
    exhausted.test(reason) ||
    classifyComputeGrantFailure({ status: 401, body: reason }).verdict === 'payment_required'
  );
}

/** Read only native diagnostic records, retaining their JSON/indented continuations. */
function legacyCodexDiagnostics(output: string): string[] {
  if (output.trim() === 'oauth_refresh_invalid') return [output.trim()];
  let commandOutput = false;
  let diagnostic = false;
  const lines: string[] = [];
  for (const line of output.split('\n')) {
    if (line.startsWith('[Codex command output]')) {
      commandOutput = true;
      diagnostic = false;
    } else if (line.startsWith('[Codex exit_code]')) commandOutput = false;
    else if (!commandOutput) {
      const header =
        /^\[Codex\] (?:Error|Turn failed):/.test(line) ||
        /^\d{4}-\d{2}-\d{2}T\S+\s+ERROR\s+codex_login::auth\S*:\s+Failed to refresh token\b/.test(
          line
        );
      const fallback = line === CODEX_AZURE_SWITCH_LINE;
      const continuation =
        /^(?:\s+|[{}"\]]|invalid_grant\b|(?:invalid_)?refresh_token_\w+\b|Your session has ended\b)/i.test(
          line
        );
      if (header || fallback) lines.push(line);
      else if (diagnostic && continuation) lines[lines.length - 1] += `\n${line}`;
      diagnostic = header || (diagnostic && continuation);
    }
  }
  return lines;
}

export async function detectAndMarkCodexExhaustion(
  taskId: string,
  output: string,
  credentialFeedback?: CodexCredentialFeedback[]
): Promise<void> {
  // A supplied structured list is authoritative, including no observed failures.
  if (credentialFeedback?.length === 0) return;

  const session = await repo.findSessionById(taskId);
  if (session === null)
    return log.warn(`Codex credential exhaustion detected for unknown session ${taskId}`);

  // After a recorded switch the funded Azure deployment serves the task, not its login.
  const hasOAuthCredential =
    (session.claudeTokenIntegrationId ?? '') !== '' && session.claudeTokenSource !== 'azure';
  let switched = credentialFeedback?.some((feedback) => feedback.source === 'oauth') === true;
  let oauthReason = '';
  let oauthRevoked = false;
  let fundedKeyReason = '';

  if (credentialFeedback !== undefined) {
    for (const feedback of credentialFeedback) {
      if (feedback.source === 'oauth' || (feedback.source === 'initial' && hasOAuthCredential)) {
        const revoked = isRevokedCodexOAuth(feedback.reason);
        if (revoked || !oauthReason) {
          oauthReason = feedback.reason;
          oauthRevoked = revoked;
        }
      } else if (
        feedback.source === 'funded_api_key' ||
        (feedback.source === 'initial' && !hasOAuthCredential)
      ) {
        fundedKeyReason ||= feedback.reason;
      }
    }
  } else {
    // Compatibility path for older workers that only POST the terminal
    // snapshot. Current workers send ordered structured credential feedback,
    // which is not vulnerable to the 500-row terminal display bound.
    let funded = !hasOAuthCredential;
    for (const diagnostic of legacyCodexDiagnostics(output)) {
      if (diagnostic === CODEX_AZURE_SWITCH_LINE) {
        funded = true;
        switched = hasOAuthCredential;
        continue;
      }
      if (funded) {
        if (isCodexExhaustion(diagnostic)) fundedKeyReason ||= diagnostic;
      } else {
        const revoked = isRevokedCodexOAuth(diagnostic);
        if (revoked || (!oauthReason && isCodexExhaustion(diagnostic))) {
          oauthReason = diagnostic;
          oauthRevoked = revoked;
        }
      }
    }
  }

  if (oauthReason !== '') await markCodexOAuthFailure(taskId, session, oauthReason, oauthRevoked);
  // The sandbox switched to Azure (auth_fallback): later limits belong to Azure (C15 report).
  if (switched && session.claudeTokenSource !== 'azure') {
    await repo.markSessionServedByAzure(taskId);
    log.info(`Codex session ${taskId} switched from its ChatGPT login to the Azure deployment`);
  }

  // The funded Codex path is the Azure deployment (never GPT_API_KEY): back off what spawns read.
  if (isCodexExhaustion(fundedKeyReason)) {
    await markCodexFundedCooldown(parseCodexResetTime(fundedKeyReason));
    log.warn(`Codex funded Azure deployment backed off for session ${taskId}`);
  }
}

async function markCodexOAuthFailure(
  taskId: string,
  session: NonNullable<Awaited<ReturnType<typeof repo.findSessionById>>>,
  reason: string,
  revoked: boolean
): Promise<void> {
  const integrationId = session.claudeTokenIntegrationId ?? '';
  if (integrationId === '')
    return log.warn(`Codex OAuth exhaustion lacks credential identity for session ${taskId}`);
  if (revoked) {
    const integration = await repo.findCredentialIntegration(integrationId);
    if (integration) {
      await markGptUserTokenRateLimited(integration.userId, {
        integrationId,
        accountId: integration.accountId,
        failureReason: 'auth_error',
      });
    }
  } else {
    const resetAt = parseCodexResetTime(reason);
    await markGptIntegrationRateLimited(integrationId, { rateLimitedUntil: resetAt });
    log.warn(`Codex OAuth credential backed off for session ${taskId}`, {
      integrationId,
      source: session.claudeTokenSource,
      resetAt: resetAt?.toISOString(),
    });
  }
}
