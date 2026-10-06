import type { GrepMatch } from './types';

export function sortMatches(matches: GrepMatch[], oldestFirst: boolean): GrepMatch[] {
  return [...matches].sort((a, b) => {
    const byTime = oldestFirst
      ? Date.parse(a.timestamp) - Date.parse(b.timestamp)
      : Date.parse(b.timestamp) - Date.parse(a.timestamp);
    if (byTime !== 0) return byTime;
    return a.path.localeCompare(b.path);
  });
}
