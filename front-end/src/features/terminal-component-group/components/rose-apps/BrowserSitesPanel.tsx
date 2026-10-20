/**
 * STATE MACHINE: BrowserSitesPanel (Browser drawer "Sites" list; plan row A6)
 *
 *   [HIDDEN] (drawer chrome "Sites" not pressed) -- no request
 *   --"Sites"--> [LOADING] GET /browser-world/sites --> [LIST] | [EMPTY] | [ERROR]
 *   [LIST] one row per Root site: site, cookie count, updated time, last writer
 *     row --Forget--> [CONFIRM(site)] "Forget github.com? Agents lose this login."
 *       --Cancel--> [LIST]
 *       --Forget--> DELETE /browser-world/sites/:site --> row removed --> [LIST]
 *       DELETE failed --> [CONFIRM(site)] + muted error
 *   --"Sites" again--> [HIDDEN]
 */

import { useState } from 'react';
import type { RootSiteView } from '@/lib/api/browser-world';
import { cookieCountText, lastWriterText, updatedText } from './browserWorldView';
import { useForgetRootSite, useRootSites } from './useBrowserWorld';

const MUTED = 'text-[hsl(240_8%_45%)] dark:text-[#a3a39d]';
const TEXT_ACTION =
  'text-[12px] font-medium text-[hsl(240_15%_8%)] underline-offset-2 hover:underline disabled:cursor-default disabled:opacity-50 dark:text-[#ecece8]';

type AgentTitle = (agentId: string) => string | null;

function SiteMeta({ site, agentTitle }: { site: RootSiteView; agentTitle: AgentTitle }) {
  const parts = [
    cookieCountText(site.cookie_count),
    updatedText(site.updated_at),
    lastWriterText(site.last_writer, agentTitle),
  ].filter((part): part is string => part !== null && part !== '');
  return <span className={`min-w-0 truncate ${MUTED}`}>{parts.join(' · ')}</span>;
}

function SiteRow({ site, agentTitle }: { site: RootSiteView; agentTitle: AgentTitle }) {
  const [confirming, setConfirming] = useState(false);
  const forget = useForgetRootSite();
  return (
    <li data-testid={`browser-site-${site.site}`} className="flex flex-col gap-1 py-1.5">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="flex-none font-medium">{site.site}</span>
        <SiteMeta site={site} agentTitle={agentTitle} />
        {!confirming && (
          <button
            type="button"
            className={`ml-auto flex-none ${TEXT_ACTION}`}
            aria-label={`Forget ${site.site}`}
            onClick={() => setConfirming(true)}
          >
            Forget
          </button>
        )}
      </div>
      {confirming && (
        <div role="group" aria-label={`Confirm forgetting ${site.site}`} className="flex gap-3">
          <span className={MUTED}>Forget {site.site}? Agents lose this login.</span>
          <button
            type="button"
            className={TEXT_ACTION}
            disabled={forget.isPending}
            onClick={() => forget.mutate(site.site)}
          >
            {forget.isPending ? 'Forgetting…' : 'Forget'}
          </button>
          <button type="button" className={TEXT_ACTION} onClick={() => setConfirming(false)}>
            Cancel
          </button>
          {forget.isError && <span className={MUTED}>Couldn’t forget it. Try again.</span>}
        </div>
      )}
    </li>
  );
}

export function BrowserSitesPanel({ agentTitle }: { agentTitle: AgentTitle }) {
  const sites = useRootSites(true);
  let body: React.ReactNode;
  if (sites.isPending) body = <p className={MUTED}>Loading sites…</p>;
  else if (sites.isError) body = <p className={MUTED}>Couldn’t load sites.</p>;
  else if (sites.data.length === 0) body = <p className={MUTED}>No saved sites yet.</p>;
  else {
    body = (
      <ul aria-label="Root sites">
        {sites.data.map((site) => (
          <SiteRow key={site.site} site={site} agentTitle={agentTitle} />
        ))}
      </ul>
    );
  }
  return (
    <section
      aria-label="Sites"
      data-testid="browser-sites-panel"
      className="max-h-[40%] flex-none overflow-y-auto border-b border-gray-200/90 px-[18px] py-2 text-[12.5px] dark:border-white/[0.07]"
    >
      {body}
    </section>
  );
}
