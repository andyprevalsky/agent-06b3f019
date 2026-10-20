/**
 * Text formatting for the Rose Desktop sync progress bar (SyncProgressBar.tsx).
 * Kept out of the component module so that file only exports components
 * (react-refresh/only-export-components).
 */

/** "45 s", "4 min", "1 h 5 min". */
export function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.max(seconds, 1)} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
