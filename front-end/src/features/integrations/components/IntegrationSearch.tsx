/**
 * STATE MACHINE: IntegrationSearch
 * [EMPTY] --type--> [FILTERED] --clear--> [EMPTY]
 * Controlled by Integrations; matching groups stay mounted with their live actions.
 */
import { useRef } from 'react';
import { Search, X } from 'lucide-react';
export default function IntegrationSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const clear = () => {
    onChange('');
    input.current?.focus();
  };
  return (
    <div
      role="search"
      className="mb-6 flex items-center gap-3 rounded-xl border border-border bg-card/70 px-4 shadow-sm transition focus-within:border-rose-400/60 focus-within:ring-2 focus-within:ring-rose-400/15"
    >
      <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
      <input
        ref={input}
        type="search"
        aria-label="Search integrations"
        placeholder="Search integrations, apps, or capabilities…"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') clear();
        }}
        className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:appearance-none"
      />
      {value !== '' && (
        <button
          type="button"
          aria-label="Clear integration search"
          onClick={clear}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
