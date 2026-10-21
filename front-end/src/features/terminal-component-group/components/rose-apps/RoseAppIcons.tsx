/**
 * STATE MACHINE: RoseAppIcons (top-right app icons, UI ledger rows 58/66)
 *
 *   [IDLE] every icon grey
 *   --click Browser | Phone | Integrations--> that app open (icon #e8507f);
 *     click it again --> [IDLE]; another icon --> switches app
 *   --click Dark mode--> useRoseTheme().toggle() (features/rose-theme, the one
 *     theme source: RoseThemeProvider persists it per user and sets html.dark);
 *     no panel. Light shows a moon labelled "Dark mode", dark shows a sun
 *     labelled "Light mode". Outside a signed-in Rose Desktop theme the
 *     toggle is a no-op (stock stays light).
 *
 * PLACEMENT (one instance on screen per viewport, useIsMobile):
 *   'corner' (md+)  four bare icons (34px hit targets, tooltip on hover) in the
 *                   window's top-right corner — no bar, background, tile or
 *                   ring. They float above the full-height drawers (z 90), so
 *                   clicking the active icon is how a drawer closes (row 67).
 *   'header' (< md) the same four icons inline at the right of the mobile
 *                   header, 40px tap targets; drawers open full screen over
 *                   them and close with their own X.
 * Rendered only with the Rose Desktop flag (stock website unchanged).
 *
 * RECONNECT DOT (row 68): the Integrations page's status data
 * (GET /api/integrations + /api/integrations/plaid/items); when any
 * integration needs reconnection the Integrations icon carries a 7px #ef4444
 * dot with a 2px background-colored ring, and its tooltip names them.
 */

import { useHoverOpen } from './useHoverOpen';
import { useQuery } from '@tanstack/react-query';
import {
  ClipboardCheck,
  Globe,
  Monitor,
  Moon,
  Plug,
  Smartphone,
  Sun,
  type LucideIcon,
} from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useRoseTheme } from '@/features/rose-theme';
import { useIsMobile } from '@/hooks/use-mobile';
import { fetchIntegrationHealth, integrationsNeedingReconnect } from '@/lib/api/integrationHealth';

import { APP_ICON_EDGE, APP_ICON_GAP, APP_ICON_SIZE } from './roseAppsLayout';
import { useRoseApps, type RoseApp } from './roseAppsState';

export const APP_ACTIVE_COLOR = '#e8507f';
/** Mobile header tap target (>= 40px). */
const HEADER_ICON_SIZE = 40;
const IDLE_COLOR = 'hsl(240 8% 45%)';
const IDLE_COLOR_DARK = '#a3a39d';

function IconButton({
  testId,
  label,
  icon: Icon,
  pressed,
  color,
  onClick,
  onHover,
  tooltip = label,
  alertDot = false,
  glowing = false,
  size,
}: {
  testId: string;
  label: string;
  icon: LucideIcon;
  pressed: boolean;
  color: string;
  onClick: () => void;
  onHover?: () => void;
  tooltip?: string;
  alertDot?: boolean;
  glowing?: boolean;
  size: number;
}) {
  const hover = useHoverOpen(onHover);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          aria-label={label}
          aria-pressed={pressed}
          data-displaying={glowing || undefined}
          onPointerEnter={hover.enter}
          onPointerLeave={hover.cancel}
          onPointerDown={hover.cancel}
          onClick={() => {
            hover.cancel();
            onClick();
          }}
          className="relative grid flex-none cursor-pointer place-items-center focus-visible:outline-none"
          style={{
            width: size,
            height: size,
            color,
            filter: glowing
              ? 'drop-shadow(0 0 5px #9cddff) drop-shadow(0 0 11px #83cfff80)'
              : undefined,
          }}
        >
          <Icon className="h-[21px] w-[21px]" strokeWidth={1.7} />
          {alertDot && (
            <i
              data-testid={`${testId}-alert`}
              aria-hidden="true"
              style={{ right: (size - 22) / 2, top: (size - 22) / 2 }}
              className="absolute block h-[7px] w-[7px] rounded-full bg-[#ef4444] shadow-[0_0_0_2px_#fff] dark:shadow-[0_0_0_2px_#262624]"
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4} className="px-2 py-1 text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

const APPS: { app: RoseApp; label: string; icon: LucideIcon }[] = [
  { app: 'display', label: 'Agent Display', icon: Monitor },
  { app: 'browser', label: 'Browser', icon: Globe },
  { app: 'validation', label: 'Validation Criteria', icon: ClipboardCheck },
  { app: 'phone', label: 'Phone', icon: Smartphone },
  { app: 'integrations', label: 'Integrations', icon: Plug },
];

function useReconnectNeeded(): string[] {
  const query = useQuery({
    queryKey: ['rose-integration-health'],
    queryFn: fetchIntegrationHealth,
    staleTime: 60_000,
    retry: false,
  });
  return query.data === undefined ? [] : integrationsNeedingReconnect(query.data);
}

export function RoseAppIcons({ placement = 'corner' }: { placement?: 'corner' | 'header' }) {
  const apps = useRoseApps();
  const theme = useRoseTheme();
  const isMobile = useIsMobile();
  const header = placement === 'header';
  const fullDrawerOpen = ['browser', 'display', 'validation'].includes(apps?.openApp ?? '');
  if (apps === null || header !== isMobile) return null;
  return (
    <nav
      aria-label="Apps"
      data-testid="rose-app-icons"
      data-placement={placement}
      className={
        header
          ? 'flex min-w-0 items-center overflow-x-auto'
          : 'fixed z-[90] hidden items-center md:flex'
      }
      style={
        header
          ? undefined
          : fullDrawerOpen
            ? {
                top: 11,
                left: 'calc(50% + 32px)',
                transform: 'translateX(-50%)',
                gap: APP_ICON_GAP,
              }
            : { top: 11, right: APP_ICON_EDGE, gap: APP_ICON_GAP }
      }
    >
      <AppIconButtons
        apps={apps}
        isDark={theme.isDark}
        onToggleTheme={theme.toggle}
        showDisplay={!header}
        size={header ? HEADER_ICON_SIZE : APP_ICON_SIZE}
      />
    </nav>
  );
}

function AppIconButtons({
  apps,
  isDark,
  onToggleTheme,
  size,
  showDisplay,
}: {
  showDisplay: boolean;
  apps: NonNullable<ReturnType<typeof useRoseApps>>;
  isDark: boolean;
  onToggleTheme: () => void;
  size: number;
}) {
  const reconnect = useReconnectNeeded();
  const hasDisplay = apps.displayEntries.some(
    (entry) => entry.agentId === apps.selectedAgentId && entry.items.length > 0,
  );
  const idle = isDark ? IDLE_COLOR_DARK : IDLE_COLOR;
  return (
    <>
      {APPS.filter(
        ({ app }) =>
          (showDisplay || app !== 'display') &&
          (app !== 'validation' || apps.selectedAgentId !== null),
      ).map(({ app, label, icon }) => (
        <IconButton
          key={app}
          testId={`rose-app-${app}`}
          label={label}
          icon={icon}
          pressed={apps.openApp === app}
          color={
            app === 'display' && hasDisplay
              ? '#9cddff'
              : apps.openApp === app
                ? APP_ACTIVE_COLOR
                : idle
          }
          glowing={app === 'display' && hasDisplay}
          onClick={() => apps.toggleApp(app)}
          onHover={() => {
            if (apps.openApp !== app) apps.toggleApp(app);
          }}
          alertDot={app === 'integrations' && reconnect.length > 0}
          tooltip={
            app === 'integrations' && reconnect.length > 0
              ? `Integrations · reconnect ${reconnect.join(', ')}`
              : label
          }
          size={size}
        />
      ))}
      <IconButton
        testId="rose-app-dark-mode"
        label={isDark ? 'Light mode' : 'Dark mode'}
        icon={isDark ? Sun : Moon}
        pressed={isDark}
        color={idle}
        onClick={onToggleTheme}
        size={size}
      />
    </>
  );
}
