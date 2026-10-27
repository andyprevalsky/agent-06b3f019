/** Paging state for an expanded work history (WorkHistoryPager), 20 activities a page. */
import { useState } from 'react';

export const WORK_HISTORY_PAGE_SIZE = 20;

export function useWorkHistoryPage(count: number) {
  const [page, setPage] = useState(0);
  const lastPage = Math.max(0, Math.ceil(count / WORK_HISTORY_PAGE_SIZE) - 1);
  const activePage = Math.min(page, lastPage);
  return {
    activePage,
    lastPage,
    setPage,
    openAtLatest: () => setPage(lastPage),
    slice: <T>(items: T[]) =>
      items.slice(activePage * WORK_HISTORY_PAGE_SIZE, (activePage + 1) * WORK_HISTORY_PAGE_SIZE),
  };
}
