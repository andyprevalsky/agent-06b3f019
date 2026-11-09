/**
 * STATE MACHINE: WorkHistoryPager (an expanded work history, 50 activities a page)
 *
 *   [PAGE n of m] --Previous activities--> [PAGE n-1]   (disabled on the first page)
 *   [PAGE n of m] --Next activities-->     [PAGE n+1]   (disabled on the last page)
 *   one page only → renders nothing
 *
 * The same page size, labels and "n / m" as the trajectory work groups; opening a
 * history lands on its latest page (useWorkHistoryPage.openAtLatest).
 */
import type { useWorkHistoryPage } from './useWorkHistoryPage';

export function WorkHistoryPager({
  activePage,
  lastPage,
  setPage,
}: Pick<ReturnType<typeof useWorkHistoryPage>, 'activePage' | 'lastPage' | 'setPage'>) {
  if (lastPage === 0) return null;
  return (
    <nav aria-label="Work history pages" className="flex gap-3 text-xs text-muted-foreground">
      <button type="button" disabled={activePage === 0} onClick={() => setPage(activePage - 1)}>
        Previous activities
      </button>
      <span role="status" aria-live="polite">
        {activePage + 1} / {lastPage + 1}
      </span>
      <button
        type="button"
        disabled={activePage === lastPage}
        onClick={() => setPage(activePage + 1)}
      >
        Next activities
      </button>
    </nav>
  );
}
