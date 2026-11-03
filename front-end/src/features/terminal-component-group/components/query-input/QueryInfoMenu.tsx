/**
 * STATE MACHINE: QueryInfoMenu (legal links at the end of the Rose nub tab)
 *
 *   [SIGNED_IN] --> no public-site menu
 *   [SIGNED_OUT/CLOSED] --click/tap info icon--> [OPEN] (tiny menu: About · Privacy · Terms)
 *   [OPEN]   --select a link | click outside | Esc--> [CLOSED]
 *
 * Rose Desktop only (the stock UI keeps its footer links). The trigger is a
 * bare white lucide Info icon on the tab, no wrapper, with the instant
 * "About · Privacy · Terms" tooltip. The menu is portaled; focus/pointer
 * events bubble through the React tree so the tab stays open while in use.
 */

import { usePublicSiteLinks } from '@/hooks/usePublicSiteLinks';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ROSE_APP_DESCRIPTION } from '@/lib/googlePublicCopy';
import { NUB_ITEM_CLASS, NubTip } from './NubTip';

export const QUERY_INFO_LINKS = [
  { label: 'About', to: '/about' },
  { label: 'Privacy', to: '/privacy' },
  { label: 'Terms', to: '/terms' },
] as const;

export function QueryInfoMenu() {
  const [open, setOpen] = useState(false);
  const showPublicLinks = usePublicSiteLinks();
  if (!showPublicLinks) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <NubTip label="About · Privacy · Terms">
        <PopoverTrigger asChild>
          <button
            type="button"
            data-nub-item
            data-testid="query-info-trigger"
            aria-label="About, Privacy and Terms"
            className={NUB_ITEM_CLASS}
          >
            <Info strokeWidth={2.2} />
          </button>
        </PopoverTrigger>
      </NubTip>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={10}
        data-testid="query-info-menu"
        className="z-[300] flex w-auto min-w-[120px] flex-col rounded-[10px] border-border bg-background p-1.5 shadow-lg dark:bg-navi-black"
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
