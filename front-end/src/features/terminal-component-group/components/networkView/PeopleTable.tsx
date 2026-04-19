import { ChevronDown, ChevronUp } from 'lucide-react';
import type { Person } from '../../hooks';
import { COLUMNS, formatPersonValue, type SortKey, type SortState } from './types';

interface PeopleTableProps {
  people: Person[];
  loading: boolean;
  hasData: boolean;
  showEmptyState: boolean;
  error: string | null;
  debouncedSearch: string;
  sort: SortState;
  onSort: (key: SortKey) => void;
}

function HeaderCell({
  columnKey,
  label,
  sort,
  onSort,
}: {
  columnKey: SortKey;
  label: string;
  sort: SortState;
  onSort: (key: SortKey) => void;
}) {
  const isActive = sort?.key === columnKey;
  return (
    <th
      onClick={() => onSort(columnKey)}
      className="px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap cursor-pointer select-none hover:text-foreground transition-colors"
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive ? (
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
  );
}

function EmptyStateRow({ debouncedSearch }: { debouncedSearch: string }) {
  return (
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
  );
}

function PersonRow({ person }: { person: Person }) {
  return (
    <tr className="border-b border-border/30 dark:border-navi-light-light-black/30 hover:bg-white/20 dark:hover:bg-black/20 transition-colors">
      <td className="px-4 py-3 whitespace-nowrap">{person.firstName}</td>
      <td className="px-4 py-3 whitespace-nowrap">{person.lastName}</td>
      <td className="px-4 py-3 whitespace-nowrap">{formatPersonValue(person.email)}</td>
      <td className="px-4 py-3 whitespace-nowrap">{formatPersonValue(person.phoneNumber)}</td>
      <td className="px-4 py-3 whitespace-nowrap font-semibold">{person.messagesExchanged}</td>
      <td className="px-4 py-3 whitespace-nowrap">{formatPersonValue(person.company)}</td>
      <td className="px-4 py-3 whitespace-nowrap">{formatPersonValue(person.title)}</td>
      <td className="px-4 py-3 whitespace-nowrap">
        {formatPersonValue(person.communicationFrequency)}
      </td>
    </tr>
  );
}

function TableBody({
  people,
  loading,
  hasData,
  showEmptyState,
  error,
  debouncedSearch,
}: {
  people: Person[];
  loading: boolean;
  hasData: boolean;
  showEmptyState: boolean;
  error: string | null;
  debouncedSearch: string;
}) {
  if (loading && people.length === 0) {
    return (
      <tr>
        <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
          Loading network...
        </td>
      </tr>
    );
  }
  if (error) {
    return (
      <tr>
        <td colSpan={8} className="px-4 py-12 text-center text-red-500">
          Error: {error}
        </td>
      </tr>
    );
  }
  if (showEmptyState) return <EmptyStateRow debouncedSearch={debouncedSearch} />;
  if (hasData) return <>{people.map((p) => <PersonRow key={p.id} person={p} />)}</>;
  return null;
}

export function PeopleTable({
  people,
  loading,
  hasData,
  showEmptyState,
  error,
  debouncedSearch,
  sort,
  onSort,
}: PeopleTableProps) {
  return (
    <div className="flex-1 overflow-auto relative flex">
      <table className="w-full text-sm">
        <thead className="sticky top-0 backdrop-blur-md border-b border-border/50 dark:border-navi-light-light-black/50 z-10">
          <tr>
            {COLUMNS.map(([key, label]) => (
              <HeaderCell
                key={key}
                columnKey={key}
                label={label}
                sort={sort}
                onSort={onSort}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          <TableBody
            people={people}
            loading={loading}
            hasData={hasData}
            showEmptyState={showEmptyState}
            error={error}
            debouncedSearch={debouncedSearch}
          />
        </tbody>
      </table>
    </div>
  );
}
