export const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? '';
export const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? '';
export const SLACK_ERROR_CHANNEL_ID = process.env.SLACK_ERROR_CHANNEL_ID ?? '';

function csv(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
  );
}

/**
 * Read at call time (not import time) so a misconfigured deploy reports the
 * exact missing variable on each event instead of silently caching a blank.
 */
export interface SlackAutoRcaConfig {
  /** Kill switch: error cards create RCA agents only when this is `1`. */
  enabled: boolean;
  /** Rose user that owns every RCA root agent (Andy in prod). */
  ownerUserId: string;
  /** GitHub repository the RCA code agent clones. */
  repoUrl: string;
  /** Slack bot ids whose top-level #errors posts are error alerts. */
  alertBotIds: ReadonlySet<string>;
  /** Slack users allowed to steer a running RCA from its thread. */
  feedbackUserIds: ReadonlySet<string>;
  /** One RCA agent per error signature per window. */
  signatureWindowMs: number;
  frontendBaseUrl: string;
}

export function getSlackAutoRcaConfig(env: NodeJS.ProcessEnv = process.env): SlackAutoRcaConfig {
  const windowMinutes = Number(env.SLACK_AUTO_RCA_SIGNATURE_WINDOW_MINUTES ?? '60');
  return {
    enabled: env.AUTO_RCA_ENABLED === '1',
    ownerUserId: (env.SLACK_AUTO_RCA_OWNER_USER_ID ?? '').trim(),
    repoUrl: (env.SLACK_AUTO_RCA_REPO_URL ?? 'https://github.com/Rose-Ai-Labs/rose').trim(),
    alertBotIds: csv(env.SLACK_AUTO_RCA_ALERT_BOT_IDS),
    feedbackUserIds: csv(env.SLACK_AUTO_RCA_FEEDBACK_USER_IDS),
    signatureWindowMs:
      Number.isFinite(windowMinutes) && windowMinutes >= 1
        ? Math.floor(windowMinutes) * 60_000
        : 60 * 60_000,
    frontendBaseUrl: (env.PUBLIC_FRONTEND_URL ?? 'https://roselabs.ai').replace(/\/+$/, ''),
  };
}

/** Later occurrences beyond this many are counted, not appended to the agent. */
export const MAX_APPENDED_OCCURRENCES = 5;
/** Bound on the error report copied into the RCA goal. */
export const MAX_ERROR_REPORT_CHARS = 6000;
