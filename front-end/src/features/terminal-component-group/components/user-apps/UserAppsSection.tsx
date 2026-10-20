/**
 * STATE MACHINE: UserAppsSection (Rose Desktop left bar, below the project
 * groups and "+ New project"; UI ledger row 10)
 *
 * Stateless; reads the Apps list + open app from UserAppsContext.
 *   not loaded (flag off, request pending/failed, 403 ROSE_DEV_ONLY) → nothing
 *   EXPANDED:  muted "Apps" label · one row per app (Rose first: Rose mark;
 *              user apps: icon_url or a neutral glyph) · "+ New app"
 *   COLLAPSED: the same 18×3px line pill used between project groups · app
 *              icons only ("+ New app" hidden, like "+ New project")
 *   [ROW] --click--> onOpenApp(id)      (full-screen app view)
 *   [+ New app] --click--> onNewApp()   (new Super Agent, composer prefilled)
 *
 * The open app = rose color + semibold. No tiles, chips, rings or pills.
 */
import { AppWindow } from 'lucide-react';
import { useState } from 'react';

import { RoseLogo } from '@/components/RoseLogo';
import type { UserAppEntry } from '@/lib/api/userApps';
import { cn } from '@/lib/utils';

import { GroupDivider } from '../rose-sidebar/RoseAgentGroups';
import { ROSE_ACTIVE_COLOR } from '../rose-sidebar/roseSidebarLayout';
import { openAppId, useUserApps } from './userAppsState';

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function AppGlyph({ app }: { app: UserAppEntry }) {
  const [broken, setBroken] = useState(false);
  if (app.kind === 'builtin') return <RoseLogo size={20} className="flex-none" />;
  if (app.icon_url && isHttpUrl(app.icon_url) && !broken) {
    return (
      <img
        src={app.icon_url}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="h-5 w-5 flex-none rounded-[4px] object-cover"
      />
    );
  }
  return <AppWindow className="h-5 w-5 flex-none" strokeWidth={1.7} />;
}

function AppRow({
  app,
  isOpen,
  isExpanded,
  onOpen,
}: {
  app: UserAppEntry;
  isOpen: boolean;
  isExpanded: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={app.title}
      aria-current={isOpen ? 'true' : undefined}
      data-testid={`rose-app-row-${app.id}`}
      data-selected={isOpen}
      title={app.title}
      className={cn(
        'flex h-[38px] w-full flex-none items-center gap-3 whitespace-nowrap px-[22px] text-left text-[13px] transition-colors',
        isOpen
          ? 'font-semibold'
          : 'text-[hsl(240_6%_50%)] hover:text-[hsl(240_15%_15%)] dark:text-[#a3a39d] dark:hover:text-[#ecece8]',
      )}
      style={isOpen ? { color: ROSE_ACTIVE_COLOR } : undefined}
    >
      <AppGlyph app={app} />
      <span
        className={cn(
          'min-w-0 flex-1 truncate transition-opacity duration-200',
          isExpanded ? 'opacity-100' : 'opacity-0',
        )}
      >
        {app.title}
      </span>
    </button>
  );
}

export function UserAppsSection({
  isExpanded,
  onOpenApp,
  onNewApp,
}: {
  isExpanded: boolean;
  onOpenApp: (appId: string) => void;
  onNewApp: () => void;
}) {
  const userApps = useUserApps();
  if (userApps === null || !userApps.loaded) return null;
  const openId = openAppId(userApps.target, userApps.apps);
  return (
    <section data-testid="rose-apps-section" aria-label="Apps" className="flex flex-col">
      {isExpanded ? (
        <div
          data-testid="rose-apps-divider"
          className="flex-none px-[22px] pb-1 pt-3 text-[11.5px] font-medium text-[hsl(240_6%_58%)] dark:text-[#a3a39d]"
        >
          Apps
        </div>
      ) : (
        userApps.apps.length > 0 && <GroupDivider />
      )}
      {userApps.apps.map((app) => (
        <AppRow
          key={app.id}
          app={app}
          isOpen={openId === app.id}
          isExpanded={isExpanded}
          onOpen={() => onOpenApp(app.id)}
        />
      ))}
      {isExpanded && (
        <button
          type="button"
          onClick={onNewApp}
          className="flex h-[30px] flex-none items-center whitespace-nowrap pl-[54px] text-left text-[13px] text-[hsl(240_8%_45%)] hover:text-[hsl(240_15%_8%)] dark:text-[#a3a39d] dark:hover:text-[#ecece8]"
        >
          + New app
        </button>
      )}
    </section>
  );
}
