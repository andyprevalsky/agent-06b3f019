/**
 * STATE MACHINE: NetworkView
 *
 * DATA LOADING:
 * [LOADING] <-- loading: true
 *     |
 *     v (fetch complete)
 * [READY] <-- loading: false
 *     |
 *     +--> (error) --> [ERROR] <-- error: string
 *     +--> (success) --> data: PeoplePaginatedResponse
 *
 * PAGINATION:
 * [PAGE_N] <-- currentPage: N
 *     |
 *     | (prev/next)
 *     v
 * [PAGE_M] --> triggers new fetch
 *
 * SORTING (server-side):
 * [UNSORTED] <-- sort: null
 *     |
 *     | (click header)
 *     v
 * [ASC] <-- sort: { key, direction: 'asc' }
 *     |
 *     | (click same header)
 *     v
 * [DESC] <-- sort: { key, direction: 'desc' }
 *     |
 *     | (click same header)
 *     v
 * [UNSORTED]
 * --> all sort changes trigger new fetch, reset to page 1
 *
 * SEARCH (server-side, debounced 300ms):
 * [NO_FILTER] <-- searchQuery: ''
 *     |
 *     | (type in search bar, debounced)
 *     v
 * [FILTERING] <-- debouncedSearch: string --> triggers new fetch, reset to page 1
 *
 * State + fetching lives in useNetworkPeople; rendering is split into
 * NetworkHeader (search + pagination) and PeopleTable (rows).
 */

import { NetworkHeader } from './networkView/NetworkHeader';
import { PeopleTable } from './networkView/PeopleTable';
import { useNetworkPeople } from './networkView/useNetworkPeople';

export default function NetworkView() {
  const {
    data,
    loading,
    error,
    currentPage,
    sort,
    searchQuery,
    debouncedSearch,
    handleSort,
    handleSearchChange,
    handlePrevPage,
    handleNextPage,
  } = useNetworkPeople();

  const hasData = Boolean(data && data.people.length > 0);
  const showEmptyState = !loading && (!data || data.people.length === 0);

  return (
    <div className="h-screen flex flex-col pt-24 pb-4">
      <div className="container max-w-[1400px] mx-auto px-6 flex flex-col flex-1 min-h-0">
        <div className="mb-4 backdrop-blur-md bg-background/80 p-6 rounded-xl border border-border/50 dark:border-navi-light-light-black/50 shrink-0">
          <h1 className="text-4xl font-bold mb-2">Network</h1>
          <p className="text-muted-foreground">Your personal and professional connections</p>
        </div>

        <div className="backdrop-blur-[12px] shadow-lg border border-border/50 dark:border-navi-light-light-black/50 rounded-xl overflow-hidden flex flex-col flex-1 min-h-0">
          <NetworkHeader
            data={data}
            searchQuery={searchQuery}
            currentPage={currentPage}
            onSearchChange={handleSearchChange}
            onPrevPage={handlePrevPage}
            onNextPage={handleNextPage}
          />
          <PeopleTable
            people={data?.people ?? []}
            loading={loading}
            hasData={hasData}
            showEmptyState={showEmptyState}
            error={error}
            debouncedSearch={debouncedSearch}
            sort={sort}
            onSort={handleSort}
          />
        </div>
      </div>
    </div>
  );
}
