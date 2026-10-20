/**
 * STATE MACHINE: QueryInfoMenu (legal links behind the rose nub)
 *
 *   [CLOSED] --click/tap info icon--> [OPEN] (tiny menu: About · Privacy · Terms)
 *   [OPEN]   --select a link | click outside | Esc--> [CLOSED]
 *
 * Sits at the END of the query-box toolbar the rose nub reveals (Chrome
 * cleanup: the old footer legal links were removed). The trigger is a bare
 * lucide Info icon — no tile/ring/pill around it; hover changes color only.
 * The menu is portaled; focus/pointer events bubble through the React tree so
 * the nub toolbar stays open while it is in use.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ROSE_APP_DESCRIPTION } from '@/lib/googlePublicCopy';

export const QUERY_INFO_LINKS = [
  { label: 'About', to: '/about' },
  { label: 'Privacy', to: '/privacy' },
  { label: 'Terms', to: '/terms' },
] as const;

export function QueryInfoMenu() {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="query-info-trigger"
          aria-label="About, Privacy and Terms"
          title="About, Privacy and Terms"
          className="flex h-[22px] w-[22px] items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:text-foreground"
        >
          <Info className="h-[17px] w-[17px]" strokeWidth={1.8} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        data-testid="query-info-menu"
        className="flex w-auto min-w-[120px] flex-col rounded-[10px] border-border bg-background p-1.5 shadow-lg dark:bg-navi-black"
      >
        <nav aria-label="Rose information" className="flex flex-col">
          {QUERY_INFO_LINKS.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              title={link.label === 'About' ? ROSE_APP_DESCRIPTION : undefined}
              onClick={() => setOpen(false)}
              className="rounded-md px-2.5 py-[7px] text-[13px] text-foreground transition-colors hover:bg-muted"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </PopoverContent>
    </Popover>
  );
}
