import { createHmac, timingSafeEqual } from '../../providers/crypto';
import { createLogger } from '../../providers/logger';
import { retryWithBackoff } from '../../providers/retry';
import {
  GITHUB_DISPATCH_REPO,
  GITHUB_DISPATCH_TOKEN,
  SLACK_ERROR_CHANNEL_ID,
  SLACK_SIGNING_SECRET,
} from './config';
import type { ParsedSlackAutoRcaEvent, SlackAutoRcaFeedback } from './types';

const log = createLogger('SlackAutoRca');
const MAX_REQUEST_AGE_SECONDS = 5 * 60;
const MAX_FEEDBACK_LENGTH = 8000;
const SLACK_TS = /^[0-9]{10,}\.[0-9]{6}$/;
const SLACK_USER_ID = /^[UW][A-Z0-9]{8,32}$/;
const SLACK_EVENT_ID = /^Ev[A-Za-z0-9]{8,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function slackSigningConfigured(): boolean {
  return SLACK_SIGNING_SECRET !== '';
}

export function verifySlackRequest(
  rawBody: string,
  timestamp: string | undefined,
  signature: string | undefined,
  nowMs = Date.now()
): boolean {
  if (
    SLACK_SIGNING_SECRET === '' ||
    timestamp === undefined ||
    signature === undefined ||
    !/^[0-9]+$/.test(timestamp) ||
    !/^v0=[0-9a-f]{64}$/.test(signature)
  ) {
    return false;
  }
  const requestSeconds = Number(timestamp);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - requestSeconds) > MAX_REQUEST_AGE_SECONDS) return false;

  const expected = `v0=${createHmac('sha256', SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex')}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function parseFeedback(payload: Record<string, unknown>): ParsedSlackAutoRcaEvent {
  const event = payload.event;
  if (!isRecord(event) || event.type !== 'message') return { kind: 'ignored' };
  if (event.subtype !== undefined || event.bot_id !== undefined) return { kind: 'ignored' };

  const channel = event.channel;
  const threadTs = event.thread_ts;
  const messageTs = event.ts;
  const userId = event.user;
  const eventId = payload.event_id;
  const text = event.text;
  if (
    typeof channel !== 'string' ||
    channel !== SLACK_ERROR_CHANNEL_ID ||
    typeof threadTs !== 'string' ||
    !SLACK_TS.test(threadTs) ||
    typeof messageTs !== 'string' ||
    !SLACK_TS.test(messageTs) ||
    threadTs === messageTs ||
    typeof userId !== 'string' ||
    !SLACK_USER_ID.test(userId) ||
    typeof eventId !== 'string' ||
    !SLACK_EVENT_ID.test(eventId) ||
    typeof text !== 'string'
  ) {
    return { kind: 'ignored' };
  }
  const normalizedText = text.trim();
  if (normalizedText === '' || normalizedText.length > MAX_FEEDBACK_LENGTH) {
    return { kind: 'ignored' };
  }
  return {
    kind: 'feedback',
    feedback: { channel, threadTs, messageTs, userId, eventId, text: normalizedText },
  };
}

export function parseSlackAutoRcaEvent(payload: unknown): ParsedSlackAutoRcaEvent {
  if (!isRecord(payload)) return { kind: 'ignored' };
  if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
    return { kind: 'challenge', challenge: payload.challenge };
  }
  if (payload.type !== 'event_callback') return { kind: 'ignored' };
  return parseFeedback(payload);
}

async function dispatchFeedback(feedback: SlackAutoRcaFeedback): Promise<void> {
  if (GITHUB_DISPATCH_TOKEN === '') throw new Error('GITHUB_DISPATCH_TOKEN is not configured');
  const response = await fetch(`https://api.github.com/repos/${GITHUB_DISPATCH_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GITHUB_DISPATCH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'rose-auto-rca-slack',
    },
    body: JSON.stringify({
      event_type: 'agent-rca-feedback',
      client_payload: {
        slack_channel: feedback.channel,
        slack_thread_ts: feedback.threadTs,
        slack_message_ts: feedback.messageTs,
        slack_user_id: feedback.userId,
        slack_event_id: feedback.eventId,
        feedback: feedback.text,
      },
    }),
    // Keep all three attempts inside Slack's ~3 second Events API ACK window.
    // A non-2xx response then asks Slack to redeliver the same deduped event.
    signal: AbortSignal.timeout(700),
  });
  if (!response.ok) throw new Error(`GitHub feedback dispatch failed with ${response.status}`);
}

export async function queueSlackAutoRcaFeedback(feedback: SlackAutoRcaFeedback): Promise<void> {
  await retryWithBackoff(() => dispatchFeedback(feedback), {
    maxRetries: 3,
    fixedDelays: [100, 200],
    isRetryable: () => true,
    component: 'SlackAutoRcaDispatch',
  });
  log.info('Durably queued Slack RCA feedback', {
    event_id: feedback.eventId,
    channel: feedback.channel,
    thread_ts: feedback.threadTs,
    message_ts: feedback.messageTs,
    user_id: feedback.userId,
  });
}
