/**
 * Slack Web API writes for auto-RCA. Every post is a thread reply, never a
 * top-level message, so post-backs can never be parsed as a new error alert.
 * Best-effort: failures are logged and reported as `false`, never thrown.
 */
import { createLogger } from '../../providers/logger';
import { SLACK_BOT_TOKEN } from './config';

const log = createLogger('SlackAutoRca');
const SLACK_TIMEOUT_MS = 4000;

async function callSlack(method: string, body: Record<string, unknown>): Promise<boolean> {
  if (SLACK_BOT_TOKEN === '') {
    log.error('SLACK_BOT_TOKEN is not configured; auto-RCA cannot reply in Slack', { method });
    return false;
  }
  try {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    // Slack reports logical errors with HTTP 200 and `ok: false`.
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (data.ok !== true) {
      log.warn('Slack auto-RCA call not ok', { method, status: response.status, error: data.error });
      return false;
    }
    return true;
  } catch (error) {
    log.warn('Slack auto-RCA call failed', {
      method,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Escape agent- or error-controlled text for Slack mrkdwn. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function postThreadReply(channel: string, threadTs: string, text: string): Promise<boolean> {
  return callSlack('chat.postMessage', {
    channel,
    thread_ts: threadTs,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });
}

export function addReaction(channel: string, messageTs: string, name: string): Promise<boolean> {
  return callSlack('reactions.add', { channel, timestamp: messageTs, name });
}
