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
 * Dedup is an in-memory, per-process throttle (no DB): the same failure
 * signature pages at most once per THROTTLE_WINDOW_MS per backend instance, so
 * a crash-looping error can't firehose #errors. This is intentionally simple —
 * "get all the failures first, tighten if noisy". At 10k agents this is O(1)
 * per failure and holds no per-agent state (bounded map, opportunistic GC).
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

function throttled(key: string, now: number): boolean {
  const prev = lastSentAt.get(key);
  if (prev !== undefined && now - prev < THROTTLE_WINDOW_MS) return true;
  lastSentAt.set(key, now);
  if (lastSentAt.size > MAX_THROTTLE_ENTRIES) {
    for (const [k, t] of lastSentAt) {
      if (now - t > THROTTLE_WINDOW_MS) lastSentAt.delete(k);
    }
  }
  return false;
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

async function postSlackWebhook(webhook: string, payload: Record<string, unknown>): Promise<void> {
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
 * Fire the GitHub repository_dispatch that launches the auto-RCA agent. The
 * Slack message handle (`slackTs`/`slackChannel`) rides in the payload so the
 * workflow can edit that same card through its lifecycle — state travels with
 * the dispatch, never through our own DB.
 */
async function dispatchRca(
  input: AlertErrorInput,
  slackTs?: string,
  slackChannel?: string
): Promise<void> {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_DISPATCH_REPO ?? 'Rose-Ai-Labs/rose';
  if (token === undefined || token === '') {
    log.warn('AUTO_RCA_ENABLED but GITHUB_DISPATCH_TOKEN unset — RCA not dispatched');
    return;
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
          source: input.source,
          title: input.message.slice(0, 120),
          slack_ts: slackTs ?? '',
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
    } else {
      log.info('RCA agent dispatched', { source: input.source, agentId: input.agentId });
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function sendAlert(input: AlertErrorInput): Promise<void> {
  const now = Date.now();
  if (throttled(fingerprint(input.source, input.message), now)) return;

  const payload = buildSlackPayload(input);
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_ERROR_CHANNEL_ID;
  const webhook = process.env.SLACK_ERROR_WEBHOOK_URL;

  // Prefer the bot token: it yields an editable message handle for the lifecycle
  // card. Fall back to an incoming webhook (post-only, no lifecycle edits).
  let slackTs: string | undefined;
  let slackChannel: string | undefined;
  if (botToken !== undefined && botToken !== '' && channelId !== undefined && channelId !== '') {
    const posted = await postSlackBot(botToken, channelId, payload);
    slackTs = posted.ts;
    slackChannel = posted.channel ?? channelId;
  } else if (webhook !== undefined && webhook !== '') {
    await postSlackWebhook(webhook, payload);
  } else {
    log.warn('No Slack sink configured — failure observed but not alerted', {
      source: input.source,
      message: input.message.slice(0, 200),
      agentId: input.agentId,
    });
  }

  if (process.env.AUTO_RCA_ENABLED === '1' && input.agentId !== undefined && input.agentId !== '') {
    await dispatchRca(input, slackTs, slackChannel);
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
}
