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
 *
 * `formatMessageSentAt` labels a chat message by local calendar day:
 *   today → "3:36 PM" | yesterday → "Yesterday, 3:36 PM"
 *   2–10 days → "4 days ago, 3:36 PM" | older → "October 25th 2026, 3:36 PM"
 */

const ISO_DATE_TIME =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?(?![\d:])/g;
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/;

function ordinalSuffix(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][day % 10] ?? 'th';
}

/** The wait_for contract's parse: a zone-less ISO date-time is UTC (never local time). */
export function toDate(value: Date | string): Date | null {
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

const DAY_MS = 24 * 60 * 60 * 1000;

function localMidnight(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** A message's local send time, with a day label once it is before today. */
export function formatMessageSentAt(value: Date | string, now: Date = new Date()): string {
  const date = toDate(value);
  if (!date) return '';
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  // Rounded: a DST change makes one local day 23 or 25 hours long.
  const daysAgo = Math.round((localMidnight(now) - localMidnight(date)) / DAY_MS);
  if (daysAgo <= 0) return time;
  if (daysAgo === 1) return `Yesterday, ${time}`;
  if (daysAgo <= 10) return `${daysAgo} days ago, ${time}`;
  const month = date.toLocaleDateString('en-US', { month: 'long' });
  const day = date.getDate();
  return `${month} ${day}${ordinalSuffix(day)} ${date.getFullYear()}, ${time}`;
}
