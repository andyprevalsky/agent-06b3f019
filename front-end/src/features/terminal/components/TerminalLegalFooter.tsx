/**
 * STATE MACHINE: signed-in or installed app -> hidden; public website guest -> links.
 * "About" is not a page: it reveals the Rose description (tooltip on desktop,
 * popover on mobile) next to the Privacy and Terms links.
 */
import { usePublicSiteLinks } from '@/hooks/usePublicSiteLinks';
import { Link } from 'react-router-dom';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ROSE_APP_DESCRIPTION } from '@/lib/googlePublicCopy';

export function TerminalLegalFooter() {
  const showPublicLinks = usePublicSiteLinks();
  if (!showPublicLinks) return null;
  return (
    <footer
      data-testid="terminal-legal-links"
      className="relative z-10 w-full shrink-0 px-2 pb-[calc(0.25rem+var(--safe-area-inset-bottom))] text-center text-[11px] leading-[1.25] text-foreground/60 md:pb-1 md:pl-20"
    >
      <span className="hidden md:inline">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="text-foreground/75 underline underline-offset-2 hover:text-foreground"
            >
              About
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            align="center"
            className="max-w-[min(20rem,calc(100vw-2rem))] p-3 text-left text-xs leading-relaxed"
          >
            {ROSE_APP_DESCRIPTION}
          </TooltipContent>
        </Tooltip>
      </span>
      <span className="md:hidden">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="text-foreground/75 underline underline-offset-2 hover:text-foreground"
            >
              About
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="center"
            className="!animate-none z-[100] w-[min(20rem,calc(100vw-2rem))] bg-background p-3 text-left text-xs leading-relaxed text-foreground shadow-lg dark:bg-navi-black"
          >
            <p>{ROSE_APP_DESCRIPTION}</p>
          </PopoverContent>
        </Popover>
      </span>{' '}
      &middot;{' '}
      <Link
        to="/privacy"
        className="text-foreground/75 underline underline-offset-2 hover:text-foreground"
      >
        Privacy
      </Link>{' '}
      &middot;{' '}
      <Link
        to="/terms"
        className="text-foreground/75 underline underline-offset-2 hover:text-foreground"
      >
        Terms
      </Link>
    </footer>
  );
}
