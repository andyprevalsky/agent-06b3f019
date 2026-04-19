/**
 * Format a duration in seconds as `m:ss`.
 */
export function formatDuration(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = Math.floor(totalSeconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Same as {@link formatDuration} but returns `null` for missing / zero /
 * negative durations so callers can suppress the display.
 */
export function formatOptionalDuration(duration: number | undefined): string | null {
  if (duration == null || duration <= 0) return null;
  return formatDuration(duration);
}
