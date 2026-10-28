/**
 * Agents domain config — env access lives here per the domain config.ts rule.
 */

import multer from 'multer';

/** Report Bug screenshots: one image per request, held in memory for upload. */
export const MAX_BUG_REPORT_SCREENSHOT_BYTES = 10 * 1024 * 1024;

export const bugReportScreenshotUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BUG_REPORT_SCREENSHOT_BYTES, files: 1 },
});

/** Index 01 webhook: "Both" / "Recording" modes post multipart audio + text fields. */
export const index01WebhookUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

/**
 * Public origin of this API as the Index 01 app must call it (the app runs on a
 * phone, so a request-derived localhost origin is useless there). Override with
 * PUBLIC_API_BASE_URL for staging.
 */
export function getPublicApiBaseUrl(): string {
  const configured = process.env.PUBLIC_API_BASE_URL;
  return (
    configured !== undefined && configured !== '' ? configured : 'https://api.roselabs.ai'
  ).replace(/\/+$/, '');
}

/** Read a {{VAR_NAME}} prompt secret from its PROMPT_SECRET_* env var. */
export function getPromptSecret(varName: string): string | undefined {
  return process.env[`PROMPT_SECRET_${varName}`];
}

/**
 * The internal backend key that benchmark/eval runners echo in the X-Benchmark-Run
 * header to mark a created agent as a benchmark run (see routes.guards.ts →
 * isBenchmarkRequest). Read here per the domain config.ts env-access rule.
 */
export function getBenchmarkRunSecret(): string | undefined {
  const key = process.env.BACKEND_API_KEY;
  return key !== undefined && key !== '' ? key : undefined;
}

/** boxes.dev "Bug Report" thread-automation API trigger that Report Bug runs. */
export function getBoxesBugReportRunUrl(): string {
  const url = process.env.BOXES_BUG_REPORT_RUN_URL;
  return url !== undefined && url !== ''
    ? url
    : 'https://api.boxes.dev/v1/thread-automations/ta_508d7e231adb4d5fb88418e9/run';
}

/** Bearer secret for the Bug Report automation's configurable API trigger. */
export function getBoxesBugReportSecret(): string | undefined {
  const secret = process.env.BOXES_BUG_REPORT_SECRET;
  return secret !== undefined && secret.trim() !== '' ? secret.trim() : undefined;
}

/** boxes.dev app link that opens the Bug Report automation and its runs. */
export function getBoxesBugReportAppUrl(): string {
  const url = process.env.BOXES_BUG_REPORT_APP_URL;
  return url !== undefined && url !== ''
    ? url
    : 'https://boxes.dev/open/desktop?box=rose&automation=ta_508d7e231adb4d5fb88418e9';
}
