/**
 * LLM binary challenge classifier (rose-1-mini).
 *
 * Replaces heuristic title/body/html marker gating for probe + settle decisions.
 * The legacy heuristic in challengePageDetect.ts is deprecated but retained.
 *
 * Context per call: viewport screenshot + cleaned DOM text + compact network
 * metadata + page URL/title/status. Decision is challenged: boolean.
 *
 * Cost routing: each call returns OpenAI-shaped usage + actual_model so the
 * recover-challenge response can forward rows into the browser agent's
 * usage_by_model ledger → build_usage_items → AgentWorkflow._track_usage
 * (same path as web_fetch's rose-1-mini summarizer). dump_context.agent_id
 * ties LLM dumps to the owning agent.
 */
import { z } from 'zod';

import type { Page, Response } from 'playwright';

import { computeSubscriptionLeases } from '../computeSubscriptionLeases';
import { prisma } from '../database';
import { createLogger } from '../logger';
import { createStreamingCompletion } from '../rose/client';
import { responseModel } from '../rose/schema';
import type { CompletionChunk, CompletionMessage } from '../rose/types';

const log = createLogger('ChallengeLlmClassifier');

export const CHALLENGE_LLM_MODEL = 'rose-labs/rose-1-mini';
export const CHALLENGE_LLM_SETTLE_MS = 60_000;
const CLEANED_DOM_CHAR_CAP = 12_000;
const NETWORK_ENTRY_CAP = 40;
const NETWORK_BODY_CHAR_CAP = 200;
const NETWORK_SUMMARY_CHAR_CAP = 4_000;

const ChallengeClassificationSchema = z.object({
  challenged: z
    .boolean()
    .describe(
      'True when the page is still an anti-bot / CAPTCHA / access wall or otherwise unusable for the intended site task. False only when the real destination UI is visible and interactive.'
    ),
  reason: z.string().describe('One short sentence explaining the challenged/clean decision.'),
});

export type ChallengeClassification = z.infer<typeof ChallengeClassificationSchema>;

/** Token/usage row forwarded into agent cost accounting. */
export interface ChallengeClassifierLlmUsage {
  call_site: 'challenge_llm_classifier';
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  actual_model: string;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export const CHALLENGE_LLM_SYSTEM_PROMPT = `You are a binary page-state classifier for a browser agent.

Decide whether the CURRENT page is still blocked by an anti-bot challenge (CAPTCHA, bot check, access denied, blank soft-wall, rate-limit interstitial, "checking your browser", vendor challenge widget, empty shell that is not the real site UI) OR whether the real destination page is usable.

Return challenged=true when:
- A challenge / CAPTCHA / human-verification interstitial is visible or dominating the page
- The document is an empty/blank soft-wall, error gateway, or host-only shell without the real product UI
- Navigation failed into a block page even if some marketing text leaked into the DOM
- Network metadata still shows the soft-block described in the agent recovery reason (e.g. HTTP 429 / rate-limit on GraphQL or product APIs) even if the HTML shell looks fine
- The agent recovery reason is uncleared (product content still Loading, offers missing, cited endpoint still failing)
- A blocked third-party resource cited in the recovery reason (payment script/CDN, required widget) is still missing or failing in network evidence

Return challenged=false ONLY when:
- The real destination site UI for the target URL is visibly present and usable (navigation, primary content, interactive controls for the task)
- AND if an agent recovery reason is provided, that specific failure mode is cleared (network + DOM evidence)
- AND any cited blocked third-party resource is no longer failing in the provided evidence

Do not overfit to one vendor. Use the screenshot as ground truth for what a human would see; use the agent DOM tree + network metadata (including HTTP status and truncated response bodies) as supporting evidence. Prefer challenged=true when uncertain.`;

export interface ChallengeClassifierContext {
  url: string;
  title: string;
  status: number | null;
  cleanedDom: string;
  networkSummary: string;
  screenshotBase64Png: string | null;
  recoveryReason?: string | null;
}

export interface ChallengeClassifierBilling {
  agentId?: string;
  userId?: string;
}

async function collectCompletion(stream: AsyncIterable<CompletionChunk>): Promise<{
  text: string;
  usage: ChallengeClassifierLlmUsage;
  actualModel: string;
}> {
  let text = '';
  let actualModel = CHALLENGE_LLM_MODEL;
  let usage: ChallengeClassifierLlmUsage = {
    call_site: 'challenge_llm_classifier',
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    actual_model: CHALLENGE_LLM_MODEL,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  for await (const chunk of stream) {
    if (chunk.actual_model) actualModel = chunk.actual_model;
    text += chunk.choices[0]?.delta?.content ?? '';
    if (chunk.usage) {
      usage = {
        call_site: 'challenge_llm_classifier',
        prompt_tokens: chunk.usage.prompt_tokens ?? 0,
        completion_tokens: chunk.usage.completion_tokens ?? 0,
        total_tokens: chunk.usage.total_tokens ?? 0,
        actual_model: actualModel,
        cache_read_input_tokens: chunk.usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: chunk.usage.cache_creation_input_tokens ?? 0,
      };
    }
  }
  usage = { ...usage, actual_model: actualModel };
  return { text: text.trim(), usage, actualModel };
}

/** Wait for load + network quiet (best-effort) before classifying. */
export async function waitForDomSettled(
  page: Page,
  timeoutMs: number = CHALLENGE_LLM_SETTLE_MS
): Promise<void> {
  const started = Date.now();
  await page
    .waitForLoadState('domcontentloaded', { timeout: Math.min(15_000, timeoutMs) })
    .catch(() => undefined);
  const remaining = Math.max(0, timeoutMs - (Date.now() - started));
  if (remaining > 0) {
    await page.waitForLoadState('networkidle', { timeout: remaining }).catch(() => undefined);
  }
  // Short quiet period so late title/body hydration can land.
  await page.waitForTimeout(1_500);
}

export async function captureCleanedDom(page: Page): Promise<string> {
  try {
    const cleaned = await page.evaluate(
      `((charCap) => {
        const body = document.body;
        if (!body) return '';
        const clone = body.cloneNode(true);
        clone
          .querySelectorAll('script, style, noscript, svg, iframe')
          .forEach((node) => node.remove());
        return (clone.innerText || clone.textContent || '')
          .replace(/\\s+/g, ' ')
          .trim()
          .slice(0, charCap);
      })(${CLEANED_DOM_CHAR_CAP})`
    );
    return typeof cleaned === 'string' ? cleaned : '';
  } catch {
    return '';
  }
}

type NetworkSummaryEntry = {
  url?: string;
  name?: string;
  status?: number | null;
  statusText?: string | null;
  status_text?: string | null;
  durationMs?: number | null;
  duration_ms?: number | null;
  transferSize?: number | null;
  size_bytes?: number | null;
  response_body?: string | null;
  response_body_truncated?: boolean;
};

function truncateBody(
  text: string,
  cap: number = NETWORK_BODY_CHAR_CAP
): {
  snippet: string;
  truncated: boolean;
} {
  if (text.length <= cap) return { snippet: text, truncated: false };
  return { snippet: text.slice(0, cap), truncated: true };
}

export function formatNetworkSummaryLines(entries: NetworkSummaryEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const url = String(entry.url || entry.name || '').slice(0, 180);
    const duration = entry.duration_ms ?? entry.durationMs ?? null;
    const size = entry.size_bytes ?? entry.transferSize ?? null;
    const status = entry.status;
    const statusText = String(entry.status_text || entry.statusText || '').trim();
    const parts: string[] = [];
    if (status !== null && status !== undefined && String(status).trim() !== '') {
      parts.push(`status=${status}`);
      if (statusText) parts.push(statusText);
    }
    if (duration !== null && duration !== undefined)
      parts.push(`${Math.round(Number(duration))}ms`);
    if (size !== null && size !== undefined) parts.push(`${Math.round(Number(size))}B`);
    if (url) parts.push(url);
    if (parts.length === 0) continue;
    let line = parts.join(' ');
    const body = entry.response_body;
    if (typeof body === 'string' && body) {
      const { snippet, truncated: cappedHere } = truncateBody(body);
      const truncated = Boolean(entry.response_body_truncated) || cappedHere;
      line += truncated
        ? `\n  response_body (truncated): ${snippet}`
        : `\n  response_body: ${snippet}`;
    }
    lines.push(line);
    if (lines.join('\n').length >= NETWORK_SUMMARY_CHAR_CAP) break;
  }
  if (lines.length === 0) return '(no resource timings)';
  return lines.join('\n').slice(0, NETWORK_SUMMARY_CHAR_CAP);
}

export function recoverySoftBlockStillPresent(
  networkSummary: string,
  recoveryReason?: string | null
): boolean {
  const reason = (recoveryReason || '').toLowerCase();
  const summary = (networkSummary || '').toLowerCase();
  if (!reason || !summary) return false;
  const reasonMentionsSoftBlock = [
    '429',
    'rate limit',
    'rate-limit',
    'ratelimit',
    'provisioned',
    'graphql',
    'too many requests',
    'offers loading',
    'soft-block',
    'soft block',
  ].some((token) => reason.includes(token));
  if (!reasonMentionsSoftBlock) return false;
  return (
    summary.includes('status=429') ||
    summary.includes('too many requests') ||
    summary.includes('provisioned request rate')
  );
}

export async function captureNetworkSummary(
  page: Page,
  options?: {
    networkEntries?: NetworkSummaryEntry[];
  }
): Promise<string> {
  if (options?.networkEntries && options.networkEntries.length > 0) {
    return formatNetworkSummaryLines(options.networkEntries.slice(-NETWORK_ENTRY_CAP));
  }
  try {
    const entries = await page.evaluate(
      `((cap) => {
        const resources = performance.getEntriesByType('resource');
        return resources.slice(-cap).map((entry) => {
          const row = {
            name: String(entry.name || '').slice(0, 180),
            durationMs: Math.round(entry.duration || 0),
            transferSize: Number(entry.transferSize || 0),
          };
          const maybeStatus = entry.responseStatus;
          if (typeof maybeStatus === 'number' && maybeStatus > 0) {
            row.status = maybeStatus;
          }
          return row;
        });
      })(${NETWORK_ENTRY_CAP})`
    );
    if (!Array.isArray(entries) || entries.length === 0) return '(no resource timings)';
    return formatNetworkSummaryLines(
      entries.map((entry) => ({
        url: String((entry as { name?: string }).name || ''),
        durationMs: Number((entry as { durationMs?: number }).durationMs || 0),
        transferSize: Number((entry as { transferSize?: number }).transferSize || 0),
        status:
          (entry as { status?: number }).status === undefined
            ? null
            : Number((entry as { status?: number }).status),
      }))
    );
  } catch {
    return '(network metadata unavailable)';
  }
}

export async function captureChallengeClassifierContext(
  page: Page,
  response: Response | null,
  options?: {
    agentDomTree?: string | null;
    networkEntries?: NetworkSummaryEntry[];
    recoveryReason?: string | null;
  }
): Promise<ChallengeClassifierContext> {
  const agentDom =
    typeof options?.agentDomTree === 'string' && options.agentDomTree.trim()
      ? options.agentDomTree.trim().slice(0, CLEANED_DOM_CHAR_CAP)
      : null;
  const [title, cleanedDom, networkSummary] = await Promise.all([
    page.title().catch(() => ''),
    agentDom ? Promise.resolve(agentDom) : captureCleanedDom(page),
    captureNetworkSummary(page, { networkEntries: options?.networkEntries }),
  ]);
  let screenshotBase64Png: string | null = null;
  try {
    const bytes = await page.screenshot({ type: 'png', fullPage: false });
    screenshotBase64Png = Buffer.from(bytes).toString('base64');
  } catch (error) {
    log.warn('Challenge LLM classifier screenshot failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    url: page.url(),
    title,
    status: response?.status() ?? null,
    cleanedDom,
    networkSummary,
    screenshotBase64Png,
    recoveryReason: options?.recoveryReason?.trim() || null,
  };
}

export function buildChallengeClassifierMessages(
  context: ChallengeClassifierContext
): CompletionMessage[] {
  const recoveryLines =
    context.recoveryReason && context.recoveryReason.trim()
      ? [
          `Agent recover_from_challenge reason: ${context.recoveryReason}`,
          'Return challenged=false only if this specific failure mode is cleared in DOM + network evidence (not merely because the HTML shell looks fine).',
          '',
        ]
      : [];
  const textBlock = [
    `Target URL: ${context.url}`,
    `Document title: ${context.title || '(empty)'}`,
    `Last main-document HTTP status: ${context.status ?? '(unknown)'}`,
    '',
    ...recoveryLines,
    'Network metadata (recent requests; includes HTTP status when known; response bodies are truncated and labeled when truncated):',
    context.networkSummary || '(none)',
    '',
    'DOM tree (same stripped page text the browser agent uses; scripts/styles removed):',
    context.cleanedDom || '(empty)',
    '',
    'Classify challenged true/false for this page state.',
  ].join('\n');

  const userContent: CompletionMessage['content'] = [{ type: 'text', text: textBlock }];
  if (context.screenshotBase64Png) {
    userContent.push({
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${context.screenshotBase64Png}`,
        detail: 'low',
      },
    });
  }

  return [
    { role: 'system', content: CHALLENGE_LLM_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
}

export type ChallengeClassificationWithUsage = ChallengeClassification & {
  usage: ChallengeClassifierLlmUsage | null;
};

/**
 * Price one classifier call the same way AgentWorkflow._track_usage does:
 * direct compute-token suffixes are $0; otherwise use the rose-1-mini pool
 * average (admin-health / agents pricing.py parity).
 */
export function challengeClassifierCostCents(usage: ChallengeClassifierLlmUsage): number {
  const model = usage.actual_model || CHALLENGE_LLM_MODEL;
  if (model.endsWith('-claude') || model.endsWith('-gpt')) return 0;
  // rose-1-mini waterfall mean: $0.75 / $4.00 per MTok → ¢/1k
  const inputCentsPer1k = 0.075;
  const outputCentsPer1k = 0.4;
  const isAnthropic =
    model.toLowerCase().includes('claude') || model.toLowerCase().includes('anthropic');
  const cacheReadMult = isAnthropic ? 0.1 : 0.25;
  const cacheWriteMult = isAnthropic ? 1.25 : 1.0;
  return (
    (usage.prompt_tokens * inputCentsPer1k) / 1000 +
    (usage.cache_read_input_tokens * inputCentsPer1k * cacheReadMult) / 1000 +
    (usage.cache_creation_input_tokens * inputCentsPer1k * cacheWriteMult) / 1000 +
    (usage.completion_tokens * outputCentsPer1k) / 1000
  );
}

/**
 * Persist classifier usage onto ToolUsage so credits / agent cost views see
 * rose-1-mini probe calls (including when recover-challenge later fails).
 * Fire-and-forget: classification must not fail closed on accounting errors.
 */
export function recordChallengeClassifierUsage(
  billing: ChallengeClassifierBilling,
  usage: ChallengeClassifierLlmUsage
): void {
  if (!billing.agentId || !billing.userId) {
    log.warn('Challenge LLM classifier usage not recorded (missing agentId/userId)', {
      agent_id: billing.agentId ?? null,
      has_user_id: Boolean(billing.userId),
      actual_model: usage.actual_model,
      prompt_tokens: usage.prompt_tokens,
    });
    return;
  }
  const costCents = challengeClassifierCostCents(usage);
  prisma.toolUsage
    .create({
      data: {
        userId: billing.userId,
        agentId: billing.agentId,
        toolName: 'challenge_llm_classifier',
        totalCostCents: Math.round(costCents * 100) / 100,
        usageItems: [
          {
            type: 'llm',
            call_site: usage.call_site,
            cost_cents: costCents,
            provider: usage.actual_model,
            model: usage.actual_model,
            tokens_in: usage.prompt_tokens,
            tokens_out: usage.completion_tokens,
            number_of_tokens: usage.total_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens,
            cache_creation_input_tokens: usage.cache_creation_input_tokens,
          },
        ],
      },
    })
    .then(() => {
      log.info('Challenge LLM classifier usage recorded', {
        agent_id: billing.agentId,
        actual_model: usage.actual_model,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        cost_cents: costCents,
      });
    })
    .catch((error) => {
      log.warn('Failed to record challenge LLM classifier usage', {
        agent_id: billing.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

/**
 * Fail closed: LLM/transport errors ⇒ challenged=true so probes cannot
 * promote on classifier outage. Usage is null only when the stream never
 * started (still fail closed).
 */
export async function classifyChallengeWithLlm(
  context: ChallengeClassifierContext,
  billing: ChallengeClassifierBilling = {}
): Promise<ChallengeClassificationWithUsage> {
  if (recoverySoftBlockStillPresent(context.networkSummary, context.recoveryReason)) {
    log.info('Challenge LLM classifier forced challenged — recovery soft-block still in network', {
      url: context.url.slice(0, 200),
      recovery_reason: (context.recoveryReason || '').slice(0, 200),
      agent_id: billing.agentId ?? null,
    });
    return {
      challenged: true,
      reason:
        'recovery_reason soft-block still present in network summary (HTTP 429 / rate-limit evidence uncleared)',
      usage: null,
    };
  }
  try {
    const stream = await createStreamingCompletion({
      model: CHALLENGE_LLM_MODEL,
      messages: buildChallengeClassifierMessages(context),
      max_tokens: 200,
      temperature: 0,
      response_model: responseModel('ChallengePageClassification', ChallengeClassificationSchema),
      // The user's and shared subscriptions serve before any funded key.
      ...(billing.userId
        ? { subscription_leases: computeSubscriptionLeases({ userId: billing.userId }) }
        : {}),
      dump_context: {
        call_site: 'challenge_llm_classifier',
        agent_id: billing.agentId,
        config: {
          user_id: billing.userId ?? null,
          url: context.url.slice(0, 200),
        },
      },
    });
    const collected = await collectCompletion(stream);
    const parsed = ChallengeClassificationSchema.parse(JSON.parse(collected.text));
    recordChallengeClassifierUsage(billing, collected.usage);
    log.info('Challenge LLM classifier result', {
      challenged: parsed.challenged,
      reason: parsed.reason.slice(0, 200),
      url: context.url.slice(0, 200),
      title: context.title.slice(0, 120),
      status: context.status,
      hasScreenshot: Boolean(context.screenshotBase64Png),
      cleanedDomChars: context.cleanedDom.length,
      actual_model: collected.usage.actual_model,
      prompt_tokens: collected.usage.prompt_tokens,
      completion_tokens: collected.usage.completion_tokens,
      agent_id: billing.agentId ?? null,
    });
    return { ...parsed, usage: collected.usage };
  } catch (error) {
    log.warn('Challenge LLM classifier failed closed as challenged', {
      error: error instanceof Error ? error.message : String(error),
      url: context.url.slice(0, 200),
      agent_id: billing.agentId ?? null,
    });
    return {
      challenged: true,
      reason: `classifier_error: ${error instanceof Error ? error.message : String(error)}`,
      usage: null,
    };
  }
}

/** Settle DOM, capture context, run binary LLM classifier. */
export async function classifyPageAfterSettle(
  page: Page,
  response: Response | null,
  settleTimeoutMs: number = CHALLENGE_LLM_SETTLE_MS,
  billing: ChallengeClassifierBilling = {},
  options?: {
    agentDomTree?: string | null;
    networkEntries?: NetworkSummaryEntry[];
    recoveryReason?: string | null;
  }
): Promise<{
  clean: boolean;
  reason: string;
  title: string;
  usage: ChallengeClassifierLlmUsage | null;
}> {
  await waitForDomSettled(page, settleTimeoutMs);
  const context = await captureChallengeClassifierContext(page, response, options);
  const result = await classifyChallengeWithLlm(context, billing);
  return {
    clean: !result.challenged,
    reason: result.reason,
    title: context.title,
    usage: result.usage,
  };
}
