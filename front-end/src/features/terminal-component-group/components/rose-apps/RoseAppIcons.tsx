/**
 * STATE MACHINE: RoseAppIcons (top-right app icons, UI ledger rows 58/66)
 *
 *   [IDLE] every icon grey
 *   --click Browser | Phone | Integrations--> that app open (icon #e8507f);
 *     click it again --> [IDLE]; another icon --> switches app
 *   --click Dark mode--> useRoseTheme().toggle(); no panel. Light shows a moon
 *     labelled "Dark mode", dark shows a sun labelled "Light mode".
 *
 * There is no right bar: four bare icons (34px hit targets, tooltip on hover)
 * in the window's top-right corner — no bar, background, tile or ring. Hidden
 * below md. Rendered only with the Rose Desktop flag (stock website unchanged).
 */

import { Globe, Moon, Plug, Smartphone, Sun, type LucideIcon } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { APP_ICON_EDGE, APP_ICON_GAP, APP_ICON_SIZE } from './roseAppsLayout';
import { useRoseApps, type RoseApp } from './roseAppsState';
import { useRoseTheme } from './roseTheme';

export const APP_ACTIVE_COLOR = '#e8507f';
const IDLE_COLOR = 'hsl(240 8% 45%)';
const IDLE_COLOR_DARK = '#a3a39d';

function IconButton({
  testId,
  label,
  icon: Icon,
  pressed,
  color,
  onClick,
}: {
  testId: string;
  label: string;
  icon: LucideIcon;
  pressed: boolean;
  color: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
          className="grid cursor-pointer place-items-center focus-visible:outline-none"
          style={{ width: APP_ICON_SIZE, height: APP_ICON_SIZE, color }}
        >
          <Icon className="h-[21px] w-[21px]" strokeWidth={1.7} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4} className="px-2 py-1 text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

const APPS: { app: RoseApp; label: string; icon: LucideIcon }[] = [
  { app: 'browser', label: 'Browser', icon: Globe },
  { app: 'phone', label: 'Phone', icon: Smartphone },
  { app: 'integrations', label: 'Integrations', icon: Plug },
];

export function RoseAppIcons() {
  const apps = useRoseApps();
  const theme = useRoseTheme();
  if (apps === null) return null;
  const idle = theme.isDark ? IDLE_COLOR_DARK : IDLE_COLOR;
  return (
    <nav
      aria-label="Apps"
      data-testid="rose-app-icons"
      className="fixed z-[67] hidden items-center md:flex"
      style={{ top: 11, right: APP_ICON_EDGE, gap: APP_ICON_GAP }}
    >
      {APPS.map(({ app, label, icon }) => (
        <IconButton
          key={app}
          testId={`rose-app-${app}`}
          label={label}
          icon={icon}
          pressed={apps.openApp === app}
          color={apps.openApp === app ? APP_ACTIVE_COLOR : idle}
          onClick={() => apps.toggleApp(app)}
        />
      ))}
      <IconButton
        testId="rose-app-dark-mode"
        label={theme.isDark ? 'Light mode' : 'Dark mode'}
        icon={theme.isDark ? Sun : Moon}
        pressed={theme.isDark}
        color={idle}
        onClick={theme.toggle}
      />
    </nav>
  );
}
