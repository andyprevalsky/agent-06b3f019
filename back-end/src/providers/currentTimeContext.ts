import type { CompletionMessage } from './rose/types';
import { markUncachedContext } from './rose/cache';

const utcCalendar = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

/**
 * Server clock -> trailing runtime reminder -> interactive model request.
 * Append after all existing messages so the full input prefix stays cacheable.
 * A new invocation refreshes the clock without accumulating old snapshots.
 */
export function withCurrentTimeContext(
  messages: CompletionMessage[],
  instant = new Date()
): CompletionMessage[] {
  const clock: CompletionMessage = {
    role: 'user',
    content: `<system-reminder>
Current UTC time: ${instant.toISOString()}
Current UTC date: ${utcCalendar.format(instant)}.
Use this server clock for current and relative dates. Use the current year for current-information searches when a year is needed; preserve requested historical dates. UTC is not the user's local time.
</system-reminder>`,
  };
  return [...messages, markUncachedContext(clock)];
}
