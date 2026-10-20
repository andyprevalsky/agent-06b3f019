/**
 * Slack Events API boundary for auto-RCA: signature verification and event
 * parsing. Incident handling lives in incidentService.ts.
 *
 *   #errors top-level card from a configured alert bot ──► error_alert
 *   human reply inside an alert thread                  ──► feedback
 *   url_verification                                     ──► challenge
 *   anything else (edits, bot replies, other channels)  ──► ignored
 */
import { createHash, createHmac, timingSafeEqual } from '../../providers/crypto';
import { MAX_ERROR_REPORT_CHARS, SLACK_ERROR_CHANNEL_ID, SLACK_SIGNING_SECRET } from './config';
import type { ParsedSlackAutoRcaEvent, SlackAutoRcaErrorAlert } from './types';

const MAX_REQUEST_AGE_SECONDS = 5 * 60;
const MAX_FEEDBACK_LENGTH = 8000;
const SLACK_TS = /^[0-9]{10,}\.[0-9]{6}$/;
const SLACK_USER_ID = /^[UW][A-Z0-9]{8,32}$/;
const SLACK_BOT_ID = /^B[A-Z0-9]{8,32}$/;
const SLACK_EVENT_ID = /^Ev[A-Za-z0-9]{8,64}$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const MAX_MENTIONED_AGENTS = 10;

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

function textOf(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return typeof value.text === 'string' ? value.text : null;
}

/** Flatten Slack Block Kit text (header, section text + fields, context). */
export function flattenSlackBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  const lines: string[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const own = textOf(block.text);
    if (own !== null) lines.push(own);
    for (const list of [block.fields, block.elements]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const text = textOf(item);
        if (text !== null) lines.push(text);
      }
    }
  }
  return lines.join('\n');
}

function buildReport(text: string, blocks: unknown): string {
  const flattened = flattenSlackBlocks(blocks);
  const report = flattened.trim() === '' ? text : flattened;
  // The report is embedded between <error_report> tags; never let it close them.
  return report.replace(/<\/?error_report/gi, '[error_report').slice(0, MAX_ERROR_REPORT_CHARS);
}

/**
 * Stable incident signature: the alert's plain-text fallback with ids, hex and
 * numbers stripped, so the same failure on different agents maps to one RCA.
 */
export function errorSignature(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(UUID, '<uuid>')
    .replace(/0x[0-9a-f]+/g, '<hex>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return createHash('sha256').update(normalized).digest('hex');
}

/** Agent ids the card mentions (bounded), used to skip failures of RCA agents. */
export function mentionedAgentIds(report: string): string[] {
  const ids = new Set<string>();
  for (const match of report.matchAll(UUID)) {
    ids.add(match[0].toLowerCase());
    if (ids.size >= MAX_MENTIONED_AGENTS) break;
  }
  return [...ids];
}

function parseErrorAlert(
  payload: Record<string, unknown>,
  event: Record<string, unknown>
): ParsedSlackAutoRcaEvent {
  const { channel, ts, bot_id: botId, text } = event;
  const eventId = payload.event_id;
  if (
    channel !== SLACK_ERROR_CHANNEL_ID ||
    typeof ts !== 'string' ||
    !SLACK_TS.test(ts) ||
    typeof botId !== 'string' ||
    !SLACK_BOT_ID.test(botId) ||
    typeof eventId !== 'string' ||
    !SLACK_EVENT_ID.test(eventId) ||
    typeof text !== 'string' ||
    text.trim() === ''
  ) {
    return { kind: 'ignored' };
  }
  const alert: SlackAutoRcaErrorAlert = {
    channel,
    messageTs: ts,
    botId,
    eventId,
    text: text.trim(),
    report: buildReport(text, event.blocks),
  };
  return { kind: 'error_alert', alert };
}

function parseFeedback(
  payload: Record<string, unknown>,
  event: Record<string, unknown>
): ParsedSlackAutoRcaEvent {
  const { channel, thread_ts: threadTs, ts: messageTs, user: userId, text } = event;
  const eventId = payload.event_id;
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

function parseMessage(payload: Record<string, unknown>): ParsedSlackAutoRcaEvent {
  const event = payload.event;
  if (!isRecord(event) || event.type !== 'message') return { kind: 'ignored' };
  const topLevel = event.thread_ts === undefined || event.thread_ts === event.ts;
  if (event.bot_id !== undefined) {
    // Bot replies (including our own post-backs) never trigger anything; only a
    // bot's top-level card is an alert. `bot_message` is an incoming-webhook post.
    const plainPost = event.subtype === undefined || event.subtype === 'bot_message';
    return topLevel && plainPost ? parseErrorAlert(payload, event) : { kind: 'ignored' };
  }
  if (event.subtype !== undefined || topLevel) return { kind: 'ignored' };
  return parseFeedback(payload, event);
}

export function parseSlackAutoRcaEvent(payload: unknown): ParsedSlackAutoRcaEvent {
  if (!isRecord(payload)) return { kind: 'ignored' };
  if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
    return { kind: 'challenge', challenge: payload.challenge };
  }
  if (payload.type !== 'event_callback') return { kind: 'ignored' };
  return parseMessage(payload);
}
