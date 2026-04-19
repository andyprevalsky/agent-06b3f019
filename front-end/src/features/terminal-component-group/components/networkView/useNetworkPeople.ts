import { useCallback, useEffect, useRef, useState } from 'react';
import { getPeople, type PeoplePaginatedResponse } from '../../hooks';
import type { SortKey, SortState } from './types';

const DEBOUNCE_MS = 300;
const PAGE_SIZE = 50;

export function useNetworkPeople() {
  const [data, setData] = useState<PeoplePaginatedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [sort, setSort] = useState<SortState>({ key: 'communicationFrequency', direction: 'asc' });
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSort = useCallback((key: SortKey) => {
    setSort((prev) => {
      if (prev?.key !== key) return { key, direction: 'asc' };
      if (prev.direction === 'asc') return { key, direction: 'desc' };
      return null;
    });
    setCurrentPage(1);
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value);
      setCurrentPage(1);
    }, DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchPeople = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await getPeople(currentPage, PAGE_SIZE, {
          sort: sort?.key,
          sortDirection: sort?.direction,
          search: debouncedSearch || undefined,
        });
        if (!cancelled) setData(response);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load network');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void fetchPeople();
    return () => {
      cancelled = true;
    };
  }, [currentPage, sort, debouncedSearch]);

  const handlePrevPage = useCallback(() => {
    setCurrentPage((p) => (p > 1 ? p - 1 : p));
  }, []);

  const handleNextPage = useCallback(() => {
    setCurrentPage((p) => {
      if (data && p < data.pagination.totalPages) return p + 1;
      return p;
    });
  }, [data]);

  return {
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
  };
}
