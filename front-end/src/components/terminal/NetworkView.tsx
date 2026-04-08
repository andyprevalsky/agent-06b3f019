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
 * States:
 * - data: PeoplePaginatedResponse | null
 * - loading: boolean
 * - error: string | null
 * - currentPage: number
 * - sort: SortState (null | { key: SortKey, direction: 'asc' | 'desc' })
 * - searchQuery: string (immediate input value)
 * - debouncedSearch: string (debounced value sent to API)
 */

import { useState, useEffect, useRef } from 'react';
import { getPeople, PeoplePaginatedResponse } from '@/lib/api';
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

type SortKey =
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'phoneNumber'
  | 'messagesExchanged'
  | 'company'
  | 'title'
  | 'communicationFrequency';
type SortDirection = 'asc' | 'desc';
type SortState = { key: SortKey; direction: SortDirection } | null;

export default function NetworkView() {
  const [data, setData] = useState<PeoplePaginatedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [sort, setSort] = useState<SortState>({ key: 'communicationFrequency', direction: 'asc' });
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const handleSort = (key: SortKey) => {
    setSort((prev) => {
      if (prev?.key !== key) return { key, direction: 'asc' };
      if (prev.direction === 'asc') return { key, direction: 'desc' };
      return null;
    });
    setCurrentPage(1);
  };

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value);
      setCurrentPage(1);
    }, 300);
  };

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  useEffect(() => {
    const fetchPeople = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await getPeople(currentPage, 50, {
          sort: sort?.key,
          sortDirection: sort?.direction,
          search: debouncedSearch || undefined,
        });
        setData(response);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load network');
      } finally {
        setLoading(false);
      }
    };
    fetchPeople();
  }, [currentPage, sort, debouncedSearch]);

  const handlePrevPage = () => {
    if (currentPage > 1) {
      setCurrentPage(currentPage - 1);
    }
  };

  const handleNextPage = () => {
    if (data && currentPage < data.pagination.totalPages) {
      setCurrentPage(currentPage + 1);
    }
  };

  const formatValue = (value: any): string => {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'number') {
      return value.toLocaleString();
    }
    if (typeof value === 'string' && value.length === 0) return '—';
    return String(value);
  };

  const hasData = data && data.people.length > 0;
  const showEmptyState = !loading && (!data || data.people.length === 0);

  return (
    <div className="h-screen flex flex-col pt-24 pb-4">
      <div className="container max-w-[1400px] mx-auto px-6 flex flex-col flex-1 min-h-0">
        <div className="mb-4 backdrop-blur-md bg-background/80 p-6 rounded-xl border border-border/50 dark:border-navi-light-light-black/50 shrink-0">
          <h1 className="text-4xl font-bold mb-2">Network</h1>
          <p className="text-muted-foreground">Your personal and professional connections</p>
        </div>

        <div className="backdrop-blur-[12px] shadow-lg border border-border/50 dark:border-navi-light-light-black/50 rounded-xl overflow-hidden flex flex-col flex-1 min-h-0">
          {/* Header with search and pagination */}
          <div className="flex items-center justify-between p-4 border-b border-border/50 dark:border-navi-light-light-black/50">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold">Contacts</h2>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Search contacts..."
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="pl-8 pr-3 py-1.5 text-sm rounded-md border border-border/50 dark:border-navi-light-light-black/50 bg-transparent placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring w-56"
                />
              </div>
            </div>
            <div className="flex items-center gap-4">
              {data && (
                <span className="text-sm text-muted-foreground">
                  {data.pagination.total.toLocaleString()} total
                </span>
              )}
              {data && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={handlePrevPage}
                    disabled={currentPage === 1}
                    className={cn(
                      'px-3 py-1 text-sm rounded border border-border/50 dark:border-navi-light-light-black/50',
                      currentPage === 1
                        ? 'opacity-50 cursor-not-allowed'
                        : 'hover:bg-white/10 dark:hover:bg-black/10 cursor-pointer',
                    )}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="text-sm text-muted-foreground">
                    Page {currentPage} of {data.pagination.totalPages}
                  </span>
                  <button
                    onClick={handleNextPage}
                    disabled={currentPage === data.pagination.totalPages}
                    className={cn(
                      'px-3 py-1 text-sm rounded border border-border/50 dark:border-navi-light-light-black/50',
                      currentPage === data.pagination.totalPages
                        ? 'opacity-50 cursor-not-allowed'
                        : 'hover:bg-white/10 dark:hover:bg-black/10 cursor-pointer',
                    )}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Fixed height scrollable table container */}
          <div className="flex-1 overflow-auto relative flex">
            <table className="w-full text-sm">
              <thead className="sticky top-0 backdrop-blur-md border-b border-border/50 dark:border-navi-light-light-black/50 z-10">
                <tr>
                  {(
                    [
                      ['firstName', 'First'],
                      ['lastName', 'Last'],
                      ['email', 'Email'],
                      ['phoneNumber', 'Phone'],
                      ['messagesExchanged', 'Messages'],
                      ['company', 'Company'],
                      ['title', 'Title'],
                      ['communicationFrequency', 'Communication Frequency'],
                    ] as [SortKey, string][]
                  ).map(([key, label]) => (
                    <th
                      key={key}
                      onClick={() => handleSort(key)}
                      className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap cursor-pointer select-none hover:text-foreground transition-colors"
                    >
                      <span className="inline-flex items-center gap-1">
                        {label}
                        {sort?.key === key ? (
                          sort.direction === 'asc' ? (
                            <ChevronUp className="h-3 w-3" />
                          ) : (
                            <ChevronDown className="h-3 w-3" />
                          )
                        ) : (
                          <ChevronDown className="h-3 w-3 opacity-0" />
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading && !data ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                      Loading network...
                    </td>
                  </tr>
                ) : error ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-red-500">
                      Error: {error}
                    </td>
                  </tr>
                ) : showEmptyState ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center">
                      <div className="space-y-2">
                        <p className="text-muted-foreground">
                          {debouncedSearch
                            ? 'No contacts match your search'
                            : 'No people in your network yet'}
                        </p>
                        {!debouncedSearch && (
                          <p className="text-sm text-muted-foreground/70">
                            Connect your integrations to start building your network
                          </p>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : hasData ? (
                  data.people.map((person) => (
                    <tr
                      key={person.id}
                      className="border-b border-border/30 dark:border-navi-light-light-black/30 hover:bg-white/20 dark:hover:bg-black/20 transition-colors"
                    >
                      <td className="px-4 py-3 whitespace-nowrap">{person.firstName}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{person.lastName}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{formatValue(person.email)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {formatValue(person.phoneNumber)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap font-semibold">
                        {person.messagesExchanged}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">{formatValue(person.company)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{formatValue(person.title)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {formatValue(person.communicationFrequency)}
                      </td>
                    </tr>
                  ))
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
