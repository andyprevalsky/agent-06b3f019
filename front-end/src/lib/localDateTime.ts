/**
 * One display format for an absolute moment, in the browser's own time zone:
 * "October 26th, 5:00pm PDT".
 *
 *   Date | ISO string with an explicit zone (Z / ±HH:MM) → formatted
 *   ISO string without a zone                          → read as UTC (wait_for's contract)
 *   unparseable                                        → returned unchanged
 *
 * `localizeTimestamps` rewrites every ISO-8601 date-time embedded in display
 * text (e.g. the producer title "Waiting until 2026-10-26T17:23:00+00:00").
 */

const ISO_DATE_TIME =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?(?![\d:])/g;
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/;

function ordinalSuffix(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][day % 10] ?? 'th';
}

function toDate(value: Date | string): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = value.trim();
  const ms = Date.parse(HAS_ZONE.test(text) ? text : `${text}Z`);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** "October 26th, 5:00pm PDT" in the viewer's local time zone; input unchanged if invalid. */
export function formatLocalDateTime(value: Date | string): string {
  const date = toDate(value);
  if (!date) return typeof value === 'string' ? value : '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const day = Number(parts.day);
  const period = (parts.dayPeriod ?? '').toLowerCase();
  return `${parts.month} ${day}${ordinalSuffix(day)}, ${parts.hour}:${parts.minute}${period} ${parts.timeZoneName}`;
}

/** Replace each embedded ISO-8601 date-time in display text with its local format. */
export function localizeTimestamps(text: string): string {
  return text.replace(ISO_DATE_TIME, (match) => formatLocalDateTime(match));
}
