/**
 * Direct-to-Slack failure alerting.
 *
 * DESIGN — this path deliberately does NOT route through our own backend/DB.
 * The failures we most want to hear about are exactly the ones where the
 * backend or DB is unhealthy, so an alert that depends on our infra can't
 * fire when it matters. `alertError` posts straight to a Slack incoming
 * webhook (external), and — only when AUTO_RCA_ENABLED=1 — fires a GitHub
 * `repository_dispatch` straight to GitHub's API. No Prisma, no internal route.
 *
 * With Auto RCA enabled, GitHub owns the one-PR/one-Slack-card lifecycle. This
 * process dispatches the stable agent ID before creating any Slack side effect;
 * duplicate dispatches are reconciled downstream. The in-memory throttle is
 * best-effort noise control, never a correctness boundary. At 10k agents this
 * stays O(1) per failure with a bounded map.
 *
 * `alertError` is fire-and-forget and NEVER throws — it lives in callers' error
 * paths and must not turn a handled failure into an unhandled one.
 */
import { createLogger } from './logger';

const log = createLogger('ErrorAlert');

export type FailureSource = 'chat' | 'sms' | 'agent_workflow' | 'backend_crash' | 'agent_watchdog';

const SOURCE_LABEL: Record<FailureSource, string> = {
  chat: '🔴 Chat loop failed',
  sms: '🔴 SMS agent failed',
  agent_workflow: '🔴 Agent failed',
  backend_crash: '🔴 Backend crashing',
  agent_watchdog: '🔴 Agent stuck / silently died',
};

const OUTBOUND_TIMEOUT_MS = 4000;
const THROTTLE_WINDOW_MS = 5 * 60 * 1000;
const MAX_THROTTLE_ENTRIES = 5000;

const FE_BASE = process.env.PUBLIC_FRONTEND_URL ?? 'https://roselabs.ai';
const PROD_BACKEND = 'https://navi-j9a9.onrender.com';

// signature -> last-sent epoch ms. Per-process only, by design (see file header).
const lastSentAt = new Map<string, number>();
const inFlight = new Set<string>();

export interface AlertErrorInput {
  source: FailureSource;
  message: string;
  agentId?: string;
  userId?: string;
  stack?: string;
  context?: Record<string, unknown>;
}

/** Normalize a message into a stable signature (strip UUIDs/hex/numbers). */
function fingerprint(source: FailureSource, message: string): string {
  const normalized = message
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/0x[0-9a-f]+/g, '<hex>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return `${source}:${normalized}`;
}

function acquireAlertSlot(key: string, now: number): boolean {
  const prev = lastSentAt.get(key);
  if (prev !== undefined && now - prev < THROTTLE_WINDOW_MS) return false;
  if (inFlight.has(key)) return false;

  inFlight.add(key);
  for (const [candidate, sentAt] of lastSentAt) {
    if (now - sentAt >= THROTTLE_WINDOW_MS) lastSentAt.delete(candidate);
  }
  return true;
}

function finishAlertSlot(key: string, delivered: boolean, now: number): void {
  inFlight.delete(key);
  if (!delivered) return;

  // Refresh insertion order so overflow eviction always removes the oldest send.
  lastSentAt.delete(key);
  lastSentAt.set(key, now);
  while (lastSentAt.size > MAX_THROTTLE_ENTRIES) {
    const oldest = lastSentAt.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    lastSentAt.delete(oldest);
  }
}

function slackCodeBlock(value: string, limit: number): string {
  return value.replace(/```/g, "''' ").slice(0, limit);
}

function buildSlackPayload(input: AlertErrorInput): Record<string, unknown> {
  const feLink = input.agentId ? `${FE_BASE}/?agent-id=${input.agentId}` : null;
  const diag = input.agentId
    ? `cd agents && python benchmarks/agent_logs.py ${input.agentId} --url ${PROD_BACKEND} --tree --diagnostics`
    : null;

  const fieldParts: string[] = [`*Source:*\n${input.source}`];
  if (input.agentId) fieldParts.push(`*Agent:*\n\`${input.agentId}\``);
  if (input.userId) fieldParts.push(`*User:*\n\`${input.userId}\``);

  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: { type: 'plain_text', text: SOURCE_LABEL[input.source] } },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '```' + input.message.slice(0, 600) + '```' },
    },
    { type: 'section', fields: fieldParts.map((text) => ({ type: 'mrkdwn', text })) },
  ];
  if (input.context !== undefined && Object.keys(input.context).length > 0) {
    let context = '[unserializable context]';
    try {
      context = JSON.stringify(input.context);
    } catch {
      // Keep alerting best-effort even if a caller supplied a circular object.
    }
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Context:*\n\`\`\`${slackCodeBlock(context, 500)}\`\`\`` },
    });
  }
  if (input.stack !== undefined && input.stack !== '') {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Stack:*\n\`\`\`${slackCodeBlock(input.stack, 500)}\`\`\`` },
    });
  }
  if (feLink) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `<${feLink}|Open agent in the app>` },
    });
  }
  if (diag) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `\`${diag}\`` }] });
  }

  return {
    text: `${SOURCE_LABEL[input.source]}: ${input.message.slice(0, 140)}`,
    blocks,
  };
}

async function postSlackWebhook(
  webhook: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn('Slack alert non-2xx', {
        status: res.status,
        body: (await res.text()).slice(0, 200),
      });
    }
    return res.ok;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Post the initial failure card via the Slack Web API (bot token) and return the
 * message handle (`ts` + resolved channel). Unlike an incoming webhook, a
 * bot-token post can be EDITED later (`chat.update`) — that handle is what lets
 * the RCA workflow evolve one message through the failure→PR→ready lifecycle.
 * Returns `{}` if the post didn't land (logged, never throws).
 */
async function postSlackBot(
  token: string,
  channel: string,
  payload: Record<string, unknown>
): Promise<{ ts?: string; channel?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, ...payload }),
      signal: controller.signal,
    });
    // Slack returns HTTP 200 even on logical errors — the truth is in `ok`.
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      ts?: string;
      channel?: string;
      error?: string;
    };
    if (data.ok !== true) {
      log.warn('Slack chat.postMessage not ok', { status: res.status, error: data.error });
      return {};
    }
    return { ts: data.ts, channel: data.channel };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fire the GitHub repository_dispatch that launches the auto-RCA lifecycle.
 * GitHub owns Slack creation so a retry after a lost completion cannot repeat a
 * backend-created message.
 */
async function dispatchRca(input: AlertErrorInput, slackChannel?: string): Promise<boolean> {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_DISPATCH_REPO ?? 'Rose-Ai-Labs/rose';
  if (token === undefined || token === '') {
    log.warn('AUTO_RCA_ENABLED but GITHUB_DISPATCH_TOKEN unset — RCA not dispatched');
    return false;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'rose-error-alert',
      },
      body: JSON.stringify({
        event_type: 'agent-failure',
        client_payload: {
          agent_id: input.agentId ?? '',
          slack_channel: slackChannel ?? '',
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn('RCA dispatch failed', {
        status: res.status,
        body: (await res.text()).slice(0, 200),
      });
      return false;
    }
    log.info('RCA agent dispatched', { source: input.source, agentId: input.agentId });
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendAlert(input: AlertErrorInput): Promise<void> {
  // Keep ordinary alerts agent-scoped, but cap auto-RCA dispatches by incident
  // signature so one provider outage cannot launch one workflow per agent.
  const signature = fingerprint(input.source, input.message);
  const key = `alert:${input.agentId ?? '-'}:${signature}`;
  if (!acquireAlertSlot(key, Date.now())) return;

  const rcaKey = `rca:${signature}`;
  let rcaAcquired = false;
  let delivered = false;
  try {
    const botToken = process.env.SLACK_BOT_TOKEN;
    const channelId = process.env.SLACK_ERROR_CHANNEL_ID;
    const webhook = process.env.SLACK_ERROR_WEBHOOK_URL;

    if (
      process.env.AUTO_RCA_ENABLED === '1' &&
      input.agentId !== undefined &&
      input.agentId !== ''
    ) {
      rcaAcquired = acquireAlertSlot(rcaKey, Date.now());
      if (rcaAcquired) {
        const dispatched = await dispatchRca(input, channelId);
        finishAlertSlot(rcaKey, dispatched, Date.now());
        rcaAcquired = false;
        if (dispatched) {
          delivered = true;
          return;
        }
      }
    }

    const payload = buildSlackPayload(input);

    // Prefer the bot token: it yields an editable message handle for the lifecycle
    // card. Fall back to an incoming webhook (post-only, no lifecycle edits).
    if (botToken !== undefined && botToken !== '' && channelId !== undefined && channelId !== '') {
      const posted = await postSlackBot(botToken, channelId, payload);
      delivered = posted.ts !== undefined && posted.ts !== '';
    } else if (webhook !== undefined && webhook !== '') {
      delivered = await postSlackWebhook(webhook, payload);
    } else {
      log.warn('No Slack sink configured — failure observed but not alerted', {
        source: input.source,
        message: input.message.slice(0, 200),
        agentId: input.agentId,
      });
    }
  } finally {
    if (rcaAcquired) {
      // Exceptions during dispatch must not suppress the incident retry.
      finishAlertSlot(rcaKey, false, Date.now());
    }
    // Failed transports remain eligible for the next occurrence to retry.
    finishAlertSlot(key, delivered, Date.now());
  }
}

/**
 * Report a production failure to #errors (and, when AUTO_RCA_ENABLED=1, launch an
 * RCA agent). Fire-and-forget: safe to call from any catch block; never throws,
 * never blocks the caller.
 */
export function alertError(input: AlertErrorInput): void {
  try {
    void sendAlert(input).catch((err: unknown) => {
      log.warn('alertError failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  } catch (err: unknown) {
    // Guards the synchronous portion (fingerprint/throttle) — must never throw.
    log.warn('alertError threw (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Test-only: reset the in-memory throttle between cases. */
export function __resetAlertThrottleForTests(): void {
  lastSentAt.clear();
  inFlight.clear();
}
