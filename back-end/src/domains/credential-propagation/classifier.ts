import { createLogger } from '../../providers/logger';
import { computeSubscriptionLeases } from '../../providers/computeSubscriptionLeases';
import { createStreamingCompletion } from '../../providers/rose/client';
import { StructuredOutputAccumulator } from '../../providers/rose/structuredOutput';
import type {
  AgentForPropagation,
  CredentialRef,
  CredentialPropagationOutcome,
  PropagationDecision,
} from './types';
import { credentialPropagationLlmDisabled } from './config';

const log = createLogger('CredentialPropagation');

const FAILURE_REASONS = [
  'auth_exhausted',
  'nav_exhausted',
  'site_rotation_exhausted',
  'captcha_blocked',
  'antibot_blocked',
  'account_locked',
  'rate_limited',
  'user_declined',
  'task_level',
  'crashed',
  'unknown',
] as const;

type FailureReason = (typeof FAILURE_REASONS)[number];

const FAILURE_REASON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    failureReason: { type: 'string', enum: FAILURE_REASONS },
    reason: { type: 'string' },
  },
  required: ['failureReason', 'reason'],
};

function normalizeText(value: string): string {
  return value.toLowerCase();
}

function rawFailureText(agent: AgentForPropagation, messages: Array<{ text: string }>): string {
  return [agent.status, agent.statusMessage ?? '', ...messages.map((message) => message.text)]
    .join('\n')
    .slice(-12000);
}

export function heuristicDecision(
  agent: AgentForPropagation,
  messages: Array<{ text: string }>,
  credentialRefs: CredentialRef[] = []
): PropagationDecision {
  const rawError = rawFailureText(agent, messages);
  const text = normalizeText(rawError);

  if (agent.status === 'COMPLETED') {
    if (
      credentialRefs.length > 0 &&
      /(authentication failure state reached:\s*yes|saved credential (?:is |was )?rejected|credential (?:is |was )?rejected|site (?:displayed|displays|showed|shows).*?(?:your password is invalid|invalid password|invalid credentials|authentication failure)|site (?:remained|returned).*?login page.*?(?:invalid|failed)|login failed after (?:using )?(?:the )?saved credential|sign in failed after (?:using )?(?:the )?saved credential|authentication failed after (?:using )?(?:the )?saved credential)/s.test(
        text
      )
    ) {
      return {
        outcome: 'auth_failed',
        reason: 'auth_exhausted',
        rawError,
        failureReason: 'auth_exhausted',
      };
    }
    return { outcome: 'success', reason: 'agent_completed', rawError: null, failureReason: null };
  }

  if (/(captcha|recaptcha|hcaptcha|turnstile)/.test(text)) {
    return {
      outcome: 'captcha',
      reason: 'captcha_blocked',
      rawError,
      failureReason: 'captcha_blocked',
    };
  }
  if (
    /(anti[- ]?bot|bot detected|cloudflare|perimeterx|datadome|akamai|access denied)/.test(text)
  ) {
    return {
      outcome: 'antibot',
      reason: 'antibot_blocked',
      rawError,
      failureReason: 'antibot_blocked',
    };
  }
  if (/(rate limit|too many requests|\b429\b|temporarily blocked|try again later)/.test(text)) {
    return {
      outcome: 'rate_limited',
      reason: 'rate_limited',
      rawError,
      failureReason: 'rate_limited',
    };
  }
  if (/(account locked|locked account|suspended|disabled account)/.test(text)) {
    return {
      outcome: 'account_locked',
      reason: 'account_locked',
      rawError,
      failureReason: 'account_locked',
    };
  }
  if (
    /(invalid password|wrong password|incorrect password|bad credentials|invalid credentials|login failed|sign in failed|authentication failed|auth failed|credential failed|session expired|logged out)/.test(
      text
    )
  ) {
    return {
      outcome: 'auth_failed',
      reason: 'auth_exhausted',
      rawError,
      failureReason: 'auth_exhausted',
    };
  }

  return { outcome: 'task_level', reason: 'task_level', rawError, failureReason: 'task_level' };
}

export function classifierUnavailableDecision(
  agent: AgentForPropagation,
  messages: Array<{ text: string }>
): PropagationDecision {
  if (agent.status === 'COMPLETED') {
    return { outcome: 'success', reason: 'agent_completed', rawError: null, failureReason: null };
  }

  return {
    outcome: 'task_level',
    reason: 'classifier_unavailable',
    rawError: rawFailureText(agent, messages),
    failureReason: null,
  };
}

function mapFailureReason(reason: FailureReason): CredentialPropagationOutcome {
  switch (reason) {
    case 'auth_exhausted':
      return 'auth_failed';
    case 'captcha_blocked':
      return 'captcha';
    case 'antibot_blocked':
    case 'site_rotation_exhausted':
      return 'antibot';
    case 'account_locked':
      return 'account_locked';
    case 'rate_limited':
      return 'rate_limited';
    case 'nav_exhausted':
    case 'user_declined':
    case 'task_level':
    case 'crashed':
    case 'unknown':
      return 'task_level';
  }
}

function parseClassifierResponse(content: string): {
  failureReason: FailureReason;
  reason: string;
} {
  const parsed = JSON.parse(content) as { failureReason?: unknown; reason?: unknown };
  if (
    typeof parsed.failureReason !== 'string' ||
    !FAILURE_REASONS.includes(parsed.failureReason as FailureReason)
  ) {
    throw new Error('classifier returned invalid failureReason');
  }
  return {
    failureReason: parsed.failureReason as FailureReason,
    reason:
      typeof parsed.reason === 'string' && parsed.reason !== ''
        ? parsed.reason
        : parsed.failureReason,
  };
}

/* c8 ignore start -- live classifier auth/streaming path requires real compute credentials/LLM */
/**
 * The judge's subscriptions. Rose leases one only when the classifier's pool runs
 * subscription legs, and rotates through the rest before any funded key.
 */
function directAuthForClassifier(agent: AgentForPropagation) {
  if (agent.userId === undefined || agent.userId === '') return {};
  return { subscription_leases: computeSubscriptionLeases({ userId: agent.userId }) };
}
/* c8 ignore stop */

export async function classifyFailureBestEffort(
  agent: AgentForPropagation,
  messages: Array<{ role: string; text: string }>,
  credentialRefs: CredentialRef[] = []
): Promise<PropagationDecision> {
  const fallback = heuristicDecision(agent, messages, credentialRefs);
  if (agent.status === 'COMPLETED') return fallback;
  if (credentialPropagationLlmDisabled()) return fallback;

  /* c8 ignore start -- live classifier streaming path requires real LLM provider */
  try {
    const directAuth = directAuthForClassifier(agent);
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-flash',
      temperature: 0,
      max_tokens: 200,
      ...directAuth,
      messages: [
        {
          role: 'system',
          content:
            'Classify why a browser-agent run failed. Return JSON only. Preserve auth failures only when the credential itself appears invalid or expired.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            goal: agent.goal,
            status: agent.status,
            rawError: agent.statusMessage,
            messages: messages.slice(-10).map((message) => ({
              role: message.role,
              text: message.text.slice(0, 2000),
            })),
          }),
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'credential_failure_classification',
          strict: true,
          schema: FAILURE_REASON_SCHEMA,
        },
      },
    });

    const structuredOutput = new StructuredOutputAccumulator();
    for await (const chunk of stream) {
      structuredOutput.addCompletionChunk(chunk);
    }
    const content = structuredOutput.currentText();

    const parsed = parseClassifierResponse(content);
    return {
      outcome: mapFailureReason(parsed.failureReason),
      reason: parsed.failureReason,
      rawError: fallback.rawError,
      failureReason: parsed.failureReason,
    };
  } catch (error) {
    log.warn('Failure classifier unavailable; preserving raw failure without classification', {
      agent_id: agent.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return classifierUnavailableDecision(agent, messages);
  }
  /* c8 ignore stop */
}
