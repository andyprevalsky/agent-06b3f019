import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PeoplePaginatedResponse } from '../../hooks';

interface NetworkHeaderProps {
  data: PeoplePaginatedResponse | null;
  searchQuery: string;
  currentPage: number;
  onSearchChange: (value: string) => void;
  onPrevPage: () => void;
  onNextPage: () => void;
}

export function NetworkHeader({
  data,
  searchQuery,
  currentPage,
  onSearchChange,
  onPrevPage,
  onNextPage,
}: NetworkHeaderProps) {
  return (
    <div className="flex items-center justify-between p-4 border-b border-border/50 dark:border-navi-light-light-black/50">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">Contacts</h2>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search contacts..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
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
              onClick={onPrevPage}
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
              onClick={onNextPage}
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
  );
}
