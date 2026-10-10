/**
 * boxes.dev thread-automation API client (configurable API trigger).
 * POST <runUrl> with `{ prompt, threadTitle }`; omitted `execution` and
 * `target` use the automation's saved agent settings and a new devbox.
 * An accepted request returns 202 with `runPublicId`, `statusUrl` and the
 * `effective` thread title/agent controls (the prompt is not echoed).
 */

import { createLogger } from './logger';

const log = createLogger('BoxesThreadAutomations');

/** Bound every boxes.dev request so a stalled socket cannot hang Report Bug. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface RunBoxesThreadAutomationInput {
  runUrl: string;
  secret: string;
  prompt: string;
  threadTitle: string;
  /** Retrying the same request with the same key returns the original run. */
  idempotencyKey: string;
  /** Injected fetch for unit tests */
  fetchImpl?: typeof fetch;
}

export interface StartedBoxesThreadAutomationRun {
  runId: string;
  statusUrl: string | null;
  threadTitle: string;
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export async function runBoxesThreadAutomation(
  input: RunBoxesThreadAutomationInput
): Promise<StartedBoxesThreadAutomationRun> {
  const fetchImpl = input.fetchImpl ?? fetch;

  // Do not log prompt/title — they carry customer incident text.
  log.info('Starting boxes.dev automation run');

  const response = await fetchImpl(input.runUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.secret}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': input.idempotencyKey,
    },
    body: JSON.stringify({ prompt: input.prompt, threadTitle: input.threadTitle }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    parsed = null;
  }
  const payload =
    parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};

  if (!response.ok) {
    const code = stringField(payload, 'error');
    const message = stringField(payload, 'message');
    const detail =
      code !== undefined || message !== undefined
        ? [code, message].filter((part) => part !== undefined).join(': ')
        : rawText.slice(0, 500);
    log.error('boxes.dev automation run rejected', { status: response.status, detail });
    throw new Error(`boxes.dev API ${response.status}: ${detail || 'run request failed'}`);
  }

  const runId = stringField(payload, 'runPublicId');
  if (runId === undefined) {
    log.error('boxes.dev accepted the run without a run id', {
      status: response.status,
      keys: Object.keys(payload).join(','),
    });
    throw new Error(`boxes.dev API ${response.status}: accepted the run but returned no run id`);
  }

  const effective =
    payload.effective !== null && typeof payload.effective === 'object'
      ? (payload.effective as Record<string, unknown>)
      : {};
  const statusUrl = stringField(payload, 'statusUrl') ?? null;
  const threadTitle = stringField(effective, 'threadTitle') ?? input.threadTitle;
  log.info('boxes.dev automation run started', { run_id: runId, status_url: statusUrl });
  return { runId, statusUrl, threadTitle };
}
