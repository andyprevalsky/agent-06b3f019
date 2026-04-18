/**
 * Canonical structured logger for all research domains.
 *
 * Deno edge functions and CLI tools route every log through this provider so
 * we can attach consistent metadata and keep all raw console writes in one
 * place. Domain code must NOT call console.* directly; it must import slog()
 * from here (or a domain-specific helper that wraps it).
 */

export type LogLevel = 'info' | 'warn' | 'error';

function safeStringify(entry: Record<string, unknown>): string {
  try {
    return JSON.stringify(entry, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value);
  } catch {
    return JSON.stringify({
      timestamp: entry.timestamp,
      level: entry.level,
      component: entry.component,
      message: entry.message,
      logger_error: 'extra payload not serializable',
    });
  }
}

export function slog(
  level: LogLevel,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    component: 'Rose',
    message,
    ...extra,
  };
  const line = safeStringify(entry);
  if (level === 'error') {
    // deno-lint-ignore no-console -- canonical logger sink
    console.error(line);
  } else {
    // deno-lint-ignore no-console -- canonical logger sink
    console.log(line);
  }
}
