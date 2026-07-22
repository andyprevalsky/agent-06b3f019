function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;

  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Extract and validate the device IANA zone from the persisted browser fingerprint. */
export function extractFingerprintTimeZone(config: unknown): string | null {
  const fingerprint = asRecord(asRecord(config)?.fingerprint);
  return canonicalTimeZone(fingerprint?.timezone);
}

/** Render UTC and user-local clocks from one caller-supplied instant. */
export function formatUserTemporalContext(instant: Date, timeZone: string | null): string {
  if (timeZone === null) {
    return "User time zone: unknown. Do not infer the user's local date or time from UTC.";
  }

  const localDate = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(instant);
  const localTime = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(instant);

  return `Current UTC time: ${instant.toISOString()}
User time zone: ${timeZone}
User local date: ${localDate}
User local time: ${localTime}`;
}
