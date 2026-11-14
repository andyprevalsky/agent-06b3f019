/** Pure test diagnostics. No I/O, retries, environment reads or transport changes. */
export type ReportBugStage =
  | 'fixture-create'
  | 'upload-headers'
  | 'upload-body'
  | 'upload-assertions'
  | 'signed-image-headers'
  | 'signed-image-body'
  | 'signed-image-assertions'
  | 'fixture-cleanup';

export class ReportBugStageError extends Error {
  constructor(
    readonly stage: ReportBugStage,
    cause: unknown
  ) {
    super(`Report Bug stage failed: ${stage}`, { cause });
    this.name = 'ReportBugStageError';
  }
}

export async function reportBugStage<T>(
  stage: ReportBugStage,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new ReportBugStageError(stage, cause);
  }
}

/** Call after fixture creation succeeds; cleanup runs exactly once. */
export async function withReportBugCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>
): Promise<T> {
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await operation() };
  } catch (error) {
    outcome = { error };
  }
  try {
    await reportBugStage('fixture-cleanup', cleanup);
  } catch (cleanupError) {
    if ('error' in outcome) {
      throw new AggregateError(
        [outcome.error, cleanupError],
        'Operation and fixture cleanup failed',
        {
          cause: outcome.error,
        }
      );
    }
    throw cleanupError;
  }
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

function redact(text: string, secrets: readonly string[]): string {
  let safe = text;
  for (const secret of secrets) if (secret.length > 0) safe = safe.split(secret).join('[REDACTED]');
  safe = safe.replace(/\b[a-z][a-z\d+.-]*(?::\/\/|%3a%2f%2f)[^\s<>"'`]+/gi, '[URL REDACTED]');
  safe = safe.replace(/\/storage\/v1\/object\/sign\/[^\s<>"'`]+/gi, '[SIGNED PATH REDACTED]');
  safe = safe.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]');
  safe = safe.replace(
    /["']?\b(authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)["']?\s*[:=]\s*["']?[^\s,;"']+/gi,
    '$1=[REDACTED]'
  );
  safe = safe.replace(/\beyJ[a-z\d_-]+\.[a-z\d_-]+\.[a-z\d_-]+\b/gi, '[TOKEN REDACTED]');
  // assertStatus embeds the raw response after this useful status comparison.
  safe = safe.replace(/(Expected \d+, got \d+):[^\n]*/g, '$1: [response omitted]');
  return Array.from(safe, (character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && code !== 9 && code !== 10) || code === 127 ? ' ' : character;
  }).join('');
}

/**
 * Retain sanitized messages/stack/codes and bounded cause/aggregate structure.
 * Never stringify response objects, arbitrary fields or non-Error throw values.
 * Supply known credentials for exact redaction; unknown secrets in free text
 * cannot be guaranteed absent by pattern redaction alone.
 */
export function formatReportBugDiagnostic(error: unknown, secrets: readonly string[] = []): string {
  const seen = new WeakSet<object>();
  const lines: string[] = [];
  let nodes = 0;
  function visit(value: unknown, label: string, depth: number): void {
    const prefix = `${'  '.repeat(depth)}${label}`;
    if (depth > 6 || nodes >= 24) {
      lines.push(`${prefix}[traversal limit]`);
      return;
    }
    nodes += 1;
    if (!(value instanceof Error)) {
      lines.push(`${prefix}[non-Error throw omitted]`);
      return;
    }
    if (seen.has(value)) {
      lines.push(`${prefix}[cycle or repeated reference]`);
      return;
    }
    seen.add(value);
    const stage = value instanceof ReportBugStageError ? ` stage=${value.stage}` : '';
    const code =
      'code' in value && (typeof value.code === 'string' || typeof value.code === 'number')
        ? ` code=${value.code}`
        : '';
    lines.push(
      `${prefix}${redact(`${value.name}${stage}${code}: ${value.message}`, secrets).slice(0, 1024)}`
    );
    if (typeof value.stack === 'string') {
      // Remove the message header, including multiline response bodies, before frames.
      const offset = value.message.length > 0 ? value.stack.indexOf(value.message) : -1;
      const frames =
        offset >= 0 && offset <= 256
          ? value.stack.slice(offset + value.message.length)
          : value.stack;
      const safeFrames = redact(frames, secrets)
        .slice(0, 4096)
        .split('\n')
        .filter((line) => /^\s+at\s/.test(line));
      for (const frame of safeFrames.slice(0, 8))
        lines.push(`${'  '.repeat(depth + 1)}${frame.trim().slice(0, 512)}`);
      if (safeFrames.length > 8) lines.push(`${prefix}[stack frame limit]`);
    }
    if ('cause' in value) visit(value.cause, 'cause: ', depth + 1);
    if (value instanceof AggregateError && Array.isArray(value.errors)) {
      for (let index = 0; index < Math.min(value.errors.length, 12); index += 1) {
        visit(value.errors[index], `errors[${index}]: `, depth + 1);
      }
      if (value.errors.length > 12) lines.push(`${prefix}[aggregate branch limit]`);
    }
  }
  visit(error, '', 0);
  return lines.join('\n').slice(0, 16_384);
}

export const reportBugDiagnosticApi = {
  stage: reportBugStage,
  cleanup: withReportBugCleanup,
  format: formatReportBugDiagnostic,
};
