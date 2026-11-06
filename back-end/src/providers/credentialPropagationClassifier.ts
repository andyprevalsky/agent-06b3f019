import type { AgentStatus, Prisma } from '@prisma/client';
import { computeSubscriptionLeases } from './computeSubscriptionLeases';
import { prisma } from './database';
import { createLogger } from './logger';
import { createStreamingCompletion } from './rose/client';
import { StructuredOutputAccumulator } from './rose/structuredOutput';
import {
  buildCredentialClassifierSystemPrompt,
  buildCredentialClassifierUserPrompt,
} from './credentialPropagationPrompts';
export {
  buildCredentialClassifierSystemPrompt,
  buildCredentialClassifierUserPrompt,
} from './credentialPropagationPrompts';

const log = createLogger('CredentialPropagation');

export type CredentialKind =
  'cookie_bundle' | 'password' | 'steel_session' | 'email_otp' | 'minted' | 'passkey';

export interface CredentialRef {
  kind: CredentialKind;
  id: string;
  /** Minted refs: the exact identifier last typed with this credential, and its page. */
  username?: string;
  origin?: string;
}

export interface MessageForClassification {
  role: string;
  text: string;
  metadata?: Prisma.JsonValue | null;
  timestamp?: Date | string;
}

export type CredentialPropagationOutcome =
  | 'success'
  | 'auth_failed'
  | 'captcha'
  | 'antibot'
  | 'rate_limited'
  | 'account_locked'
  | 'task_level'
  | 'unused'
  | 'unknown';

export type FailureReason =
  | 'auth_exhausted'
  | 'nav_exhausted'
  | 'site_rotation_exhausted'
  | 'captcha_blocked'
  | 'antibot_blocked'
  | 'account_locked'
  | 'rate_limited'
  | 'user_declined'
  | 'task_level'
  | 'crashed'
  | 'unknown';

export interface PropagationDecision {
  outcome: CredentialPropagationOutcome;
  reason: string;
  rawError: string | null;
  failureReason: FailureReason | null;
}

export interface CredentialPropagationDecision extends PropagationDecision {
  credentialRef: CredentialRef;
}

export interface CredentialInventoryEntry extends CredentialRef {
  label: string;
  details: Record<string, unknown>;
}

export interface AgentForPropagation {
  id: string;
  userId?: string;
  goal: string;
  status: AgentStatus;
  statusMessage: string | null;
}

interface CredentialClassificationResult {
  reason: string;
  rawError: string | null;
  decisions: CredentialPropagationDecision[];
}

const CREDENTIAL_KINDS = new Set<CredentialKind>([
  'cookie_bundle',
  'password',
  'steel_session',
  'email_otp',
  'minted',
  'passkey',
]);

const CLASSIFIER_OUTCOMES = [
  'success',
  'auth_failed',
  'captcha',
  'antibot',
  'rate_limited',
  'account_locked',
  'task_level',
  'unused',
  'unknown',
] as const;

const FAILURE_REASON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: { type: 'string' },
    credentialOutcomes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reason: { type: 'string' },
          kind: { type: 'string', enum: [...CREDENTIAL_KINDS] },
          id: { type: 'string' },
          outcome: { type: 'string', enum: CLASSIFIER_OUTCOMES },
        },
        required: ['reason', 'kind', 'id', 'outcome'],
      },
    },
  },
  required: ['reason', 'credentialOutcomes'],
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeKind(kind: string): CredentialKind | null {
  const normalized = kind.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  if (normalized === 'cookie' || normalized === 'cookie_bundle') return 'cookie_bundle';
  if (normalized === 'browser_password' || normalized === 'password') return 'password';
  if (normalized === 'steel' || normalized === 'steel_auth' || normalized === 'steel_session') {
    return 'steel_session';
  }
  if (normalized === 'email' || normalized === 'email_otp' || normalized === 'otp') {
    return 'email_otp';
  }
  if (normalized === 'passkey' || normalized === 'webauthn') return 'passkey';
  // The browser agent records the minted identity as `minted_account`.
  if (normalized === 'minted_account') return 'minted';
  return CREDENTIAL_KINDS.has(normalized as CredentialKind) ? (normalized as CredentialKind) : null;
}

export function extractCredentialRefs(
  messages: Array<{ metadata: Prisma.JsonValue | null }>
): CredentialRef[] {
  const byKey = new Map<string, CredentialRef>();

  for (const message of messages) {
    if (!isObject(message.metadata)) continue;
    const rawRef = message.metadata.credential_ref ?? message.metadata.credentialRef;
    const refs = Array.isArray(rawRef) ? rawRef : [rawRef];

    for (const ref of refs) {
      if (!isObject(ref)) continue;
      const rawKind = ref.kind;
      const rawId = ref.id;
      if (typeof rawKind !== 'string' || typeof rawId !== 'string' || rawId === '') continue;
      const kind = normalizeKind(rawKind);
      if (kind === null) continue;

      const credentialRef: CredentialRef = { kind, id: rawId };
      if (kind === 'minted' && typeof ref.username === 'string' && typeof ref.origin === 'string') {
        credentialRef.username = ref.username;
        credentialRef.origin = ref.origin;
      }
      const key = `${credentialRef.kind}:${credentialRef.id}`;
      // The last identifier typed with a minted credential is the one that signed in.
      const previous = byKey.get(key);
      byKey.set(
        key,
        credentialRef.username === undefined && previous?.username !== undefined
          ? previous
          : credentialRef
      );
    }
  }

  return [...byKey.values()];
}

export function rawFailureText(
  agent: AgentForPropagation,
  messages: Array<{ text: string }>
): string {
  return [agent.status, agent.statusMessage ?? '', ...messages.map((message) => message.text)]
    .join('\n')
    .slice(-12000);
}

function credentialKey(ref: CredentialRef): string {
  return `${ref.kind}:${ref.id}`;
}

async function loadCredentialInventory(
  userId: string | undefined,
  credentialRefs: CredentialRef[]
): Promise<CredentialInventoryEntry[]> {
  if (userId === undefined || credentialRefs.length === 0) {
    return credentialRefs.map((ref) => ({ ...ref, label: credentialKey(ref), details: {} }));
  }

  const entries = new Map<string, CredentialInventoryEntry>();
  const [bundles, passwords, steelSessions, mintedAccounts, passkeys] = await Promise.all([
    prisma.cookieBundle.findMany({
      where: {
        userId,
        id: { in: credentialRefs.filter((r) => r.kind === 'cookie_bundle').map((r) => r.id) },
      },
      select: { id: true, accountLabel: true, browserSource: true, browserProfile: true },
    }),
    prisma.browserPassword.findMany({
      where: {
        userId,
        id: { in: credentialRefs.filter((r) => r.kind === 'password').map((r) => r.id) },
      },
      select: { id: true, origin: true, username: true },
    }),
    prisma.steelSessionAuth.findMany({
      where: {
        userId,
        id: { in: credentialRefs.filter((r) => r.kind === 'steel_session').map((r) => r.id) },
      },
      select: { id: true, authRealm: true, contextId: true },
    }),
    prisma.mintedAccount.findMany({
      where: {
        userId,
        id: { in: credentialRefs.filter((r) => r.kind === 'minted').map((r) => r.id) },
      },
      select: { id: true, authRealm: true, accountLabel: true },
    }),
    prisma.passkeyCredential.findMany({
      where: {
        userId,
        id: { in: credentialRefs.filter((r) => r.kind === 'passkey').map((r) => r.id) },
      },
      select: { id: true, authRealm: true, rpId: true },
    }),
  ]);

  for (const bundle of bundles) {
    const ref = { kind: 'cookie_bundle' as const, id: bundle.id };
    entries.set(credentialKey(ref), {
      ...ref,
      label: bundle.accountLabel ?? `${bundle.browserSource}:${bundle.browserProfile}`,
      details: bundle,
    });
  }
  for (const password of passwords) {
    const ref = { kind: 'password' as const, id: password.id };
    entries.set(credentialKey(ref), {
      ...ref,
      label: `${password.username}@${password.origin}`,
      details: password,
    });
  }
  for (const session of steelSessions) {
    const ref = { kind: 'steel_session' as const, id: session.id };
    entries.set(credentialKey(ref), {
      ...ref,
      label: `${session.authRealm}:${session.contextId}`,
      details: session,
    });
  }
  for (const minted of mintedAccounts) {
    const ref = { kind: 'minted' as const, id: minted.id };
    entries.set(credentialKey(ref), {
      ...ref,
      label: minted.accountLabel,
      details: minted,
    });
  }
  for (const passkey of passkeys) {
    const ref = { kind: 'passkey' as const, id: passkey.id };
    entries.set(credentialKey(ref), {
      ...ref,
      label: `passkey:${passkey.rpId}`,
      details: passkey,
    });
  }

  return credentialRefs.map(
    (ref) => entries.get(credentialKey(ref)) ?? { ...ref, label: credentialKey(ref), details: {} }
  );
}

function completedCredentialAuthFailureDecision(rawError: string): PropagationDecision | null {
  const text = rawError.toLowerCase();

  if (
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

  return null;
}

function heuristicDecision(
  agent: AgentForPropagation,
  messages: Array<{ text: string }>,
  credentialRefsPresent = false
): PropagationDecision {
  const rawError = rawFailureText(agent, messages);
  const text = rawError.toLowerCase();

  if (agent.status === 'COMPLETED') {
    if (credentialRefsPresent) {
      const completedAuthFailure = completedCredentialAuthFailureDecision(rawError);
      if (completedAuthFailure !== null) return completedAuthFailure;
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

function classifierUnavailableDecision(
  agent: AgentForPropagation,
  messages: Array<{ text: string }>
): PropagationDecision {
  return {
    outcome: 'task_level',
    reason: 'classifier_unavailable',
    rawError: rawFailureText(agent, messages),
    failureReason: null,
  };
}

function failureReasonFromOutcome(outcome: CredentialPropagationOutcome): FailureReason | null {
  switch (outcome) {
    case 'auth_failed':
      return 'auth_exhausted';
    case 'captcha':
      return 'captcha_blocked';
    case 'antibot':
      return 'antibot_blocked';
    case 'account_locked':
      return 'account_locked';
    case 'rate_limited':
      return 'rate_limited';
    case 'task_level':
      return 'task_level';
    case 'unknown':
    case 'success':
    case 'unused':
      return null;
  }
}

function decisionForCredential(
  credentialRef: CredentialRef,
  decision: PropagationDecision
): CredentialPropagationDecision {
  return { ...decision, credentialRef };
}

export function aggregateDecision(
  decisions: CredentialPropagationDecision[],
  reason: string
): PropagationDecision {
  const priority: CredentialPropagationOutcome[] = [
    'auth_failed',
    'captcha',
    'antibot',
    'account_locked',
    'rate_limited',
    'task_level',
    'unknown',
    'success',
    'unused',
  ];
  const outcome =
    priority.find((candidate) => decisions.some((decision) => decision.outcome === candidate)) ??
    'unknown';
  const selectedDecision = decisions.find((decision) => decision.outcome === outcome);
  const rawError = decisions.find((decision) => decision.rawError !== null)?.rawError ?? null;
  return { outcome, reason, rawError, failureReason: selectedDecision?.failureReason ?? null };
}

function parseClassifierResponse(
  content: string,
  credentialRefs: CredentialRef[],
  rawError: string | null
): { reason: string; decisions: CredentialPropagationDecision[] } {
  const parsed = JSON.parse(content) as { reason?: unknown; credentialOutcomes?: unknown };
  if (typeof parsed.reason !== 'string' || !Array.isArray(parsed.credentialOutcomes)) {
    throw new Error('classifier returned invalid per-credential response');
  }

  const refsByKey = new Map(credentialRefs.map((ref) => [credentialKey(ref), ref]));
  const decisionsByKey = new Map<string, CredentialPropagationDecision>();

  for (const item of parsed.credentialOutcomes) {
    if (!isObject(item)) continue;
    const kind = typeof item.kind === 'string' ? normalizeKind(item.kind) : null;
    const id = typeof item.id === 'string' ? item.id : '';
    const outcome =
      typeof item.outcome === 'string' &&
      CLASSIFIER_OUTCOMES.includes(item.outcome as CredentialPropagationOutcome)
        ? (item.outcome as CredentialPropagationOutcome)
        : null;
    const itemReason =
      typeof item.reason === 'string' && item.reason !== '' ? item.reason : parsed.reason;
    if (kind === null || id === '' || outcome === null) continue;

    const ref = refsByKey.get(`${kind}:${id}`);
    if (ref === undefined) continue;
    decisionsByKey.set(credentialKey(ref), {
      credentialRef: ref,
      outcome,
      reason: itemReason,
      rawError,
      failureReason: failureReasonFromOutcome(outcome),
    });
  }

  for (const ref of credentialRefs) {
    if (decisionsByKey.has(credentialKey(ref))) continue;
    decisionsByKey.set(credentialKey(ref), {
      credentialRef: ref,
      outcome: 'unused',
      reason: 'Classifier did not return an outcome for this credential.',
      rawError,
      failureReason: null,
    });
  }

  return { reason: parsed.reason, decisions: [...decisionsByKey.values()] };
}

/**
 * Output budget for the judge. The flash pool's model thinks before it answers
 * and its thinking counts against this cap: at 200 every call ended with no
 * answer (a real two-login run thought for 1,543 tokens), so no rejected
 * credential was ever classified.
 */
const CLASSIFIER_MAX_OUTPUT_TOKENS = 8192;

/* c8 ignore start -- live classifier auth path requires real compute credentials */
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
  messages: MessageForClassification[],
  credentialRefs: CredentialRef[] = []
): Promise<PropagationDecision> {
  const result = await classifyCredentialOutcomesBestEffort(agent, messages, credentialRefs);
  return aggregateDecision(result.decisions, result.reason);
}

export async function classifyCredentialOutcomesBestEffort(
  agent: AgentForPropagation,
  messages: MessageForClassification[],
  credentialRefs: CredentialRef[] = []
): Promise<CredentialClassificationResult> {
  const fallback = heuristicDecision(agent, messages, credentialRefs.length > 0);
  // A run-level verdict names the run, not a credential. With several
  // credentials in play and no judge, copying it onto each of them would
  // disable the one that worked (failure) or re-enable the one the site
  // rejected (success); those credentials stay unknown.
  const perCredentialFallback: PropagationDecision =
    credentialRefs.length > 1 && fallback.outcome !== 'unknown'
      ? {
          ...fallback,
          outcome: 'unknown',
          failureReason: null,
          reason: `${fallback.reason}; per-credential verdict unavailable`,
        }
      : fallback;
  const fallbackDecisions = credentialRefs.map((credentialRef) =>
    decisionForCredential(credentialRef, perCredentialFallback)
  );
  if (credentialRefs.length === 0) {
    return { reason: 'no_credentials_used', rawError: fallback.rawError, decisions: [] };
  }
  // A completed run that used one credential needs no judge: that credential
  // worked. One that tried several does: the run's success says nothing about
  // which of them the site rejected on the way.
  const oneCredentialWorked = agent.status === 'COMPLETED' && credentialRefs.length === 1;
  if (oneCredentialWorked || process.env.CREDENTIAL_PROPAGATION_DISABLE_LLM === '1') {
    return { reason: fallback.reason, rawError: fallback.rawError, decisions: fallbackDecisions };
  }

  try {
    const rawError = fallback.rawError;
    const content = await classifierContent(agent, messages, credentialRefs);
    const parsed = parseClassifierResponse(content, credentialRefs, rawError);
    return { reason: parsed.reason, rawError, decisions: parsed.decisions };
  } catch (error) {
    log.warn('Failure classifier unavailable; preserving raw failure without classification', {
      agent_id: agent.id,
      error: error instanceof Error ? error.message : String(error),
    });
    if (agent.status === 'COMPLETED') {
      // No judge, no per-credential verdict: keep what a completed run always meant.
      return { reason: fallback.reason, rawError: fallback.rawError, decisions: fallbackDecisions };
    }
    const unavailable = classifierUnavailableDecision(agent, messages);
    return {
      reason: unavailable.reason,
      rawError: unavailable.rawError,
      decisions: credentialRefs.map((credentialRef) =>
        decisionForCredential(credentialRef, unavailable)
      ),
    };
  }
}

async function classifierContent(
  agent: AgentForPropagation,
  messages: MessageForClassification[],
  credentialRefs: CredentialRef[]
): Promise<string> {
  const mockContent = process.env.CREDENTIAL_PROPAGATION_MOCK_LLM_RESPONSE;
  if (mockContent !== undefined) return mockContent;

  /* c8 ignore start -- live classifier streaming path requires real LLM provider */
  const directAuth = directAuthForClassifier(agent);
  const credentialInventory = await loadCredentialInventory(agent.userId, credentialRefs);
  const stream = await createStreamingCompletion({
    model: 'rose-labs/rose-1-flash',
    temperature: 0,
    max_tokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
    ...directAuth,
    messages: [
      { role: 'system' as const, content: buildCredentialClassifierSystemPrompt() },
      {
        role: 'user' as const,
        content: buildCredentialClassifierUserPrompt({
          agent,
          messages,
          credentialRefs,
          credentialInventory,
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
    dump_context: {
      call_site: 'credential_failure_classifier',
      agent_id: agent.id,
      config: {
        classifier: 'browser_run_credential_outcomes',
        credential_ref_count: credentialRefs.length,
      },
      extra: { credential_refs: credentialRefs, credential_inventory: credentialInventory },
    },
  });

  const structuredOutput = new StructuredOutputAccumulator();
  for await (const chunk of stream) {
    structuredOutput.addCompletionChunk(chunk);
  }
  return structuredOutput.currentText();
  /* c8 ignore stop */
}
