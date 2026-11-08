/**
 * Paging for an expanded work history (WorkHistoryPager), 50 activities a page.
 * Pages are anchored at the newest activity: the last page always holds the
 * 50 most recent (only the oldest page can be short), and histories open there.
 */
import { useState } from 'react';

export const WORK_HISTORY_PAGE_SIZE = 50;

/** Index of the last (newest) page for `count` items. */
export function lastWorkHistoryPage(count: number): number {
  return Math.max(0, Math.ceil(count / WORK_HISTORY_PAGE_SIZE) - 1);
}

/** Items on `page` (0 = oldest), counted back from the newest item. */
export function workHistoryPageSlice<T>(items: readonly T[], page: number): T[] {
  const fromEnd = lastWorkHistoryPage(items.length) - page;
  const end = items.length - fromEnd * WORK_HISTORY_PAGE_SIZE;
  return items.slice(Math.max(0, end - WORK_HISTORY_PAGE_SIZE), Math.max(0, end));
}

/**
 * The open page is kept as "pages back from the newest", so a history that
 * grows while open (a running batch crossing a multiple of 50) keeps showing
 * the newest page instead of being stranded on what became an older one.
 */
export function useWorkHistoryPage(count: number) {
  const [back, setBack] = useState(0);
  const lastPage = lastWorkHistoryPage(count);
  const activePage = Math.max(0, lastPage - back);
  return {
    activePage,
    lastPage,
    setPage: (page: number) => setBack(Math.max(0, lastPage - page)),
    openAtLatest: () => setBack(0),
  };
}
