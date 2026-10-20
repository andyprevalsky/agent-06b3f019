/**
 * STATE MACHINE: BrowserCookiesSection
 *
 * [COLLAPSED] --toggle--> [EXPANDED] --toggle--> [COLLAPSED]
 *
 * When expanded, shows list of installed browsers with sync buttons.
 * Each browser row: [IDLE] --click--> [SYNCING] --done--> [CONNECTED]
 *
 * If not in Electron, shows "Desktop Only" fallback.
 */

import type { BrowserType, BrowserInfo } from '@/features/integration-handlers-context';
import { Button } from '@/components/ui/button';

import BrowserIcon from './BrowserIcon';
import DropdownIconFrame, {
  BrowserDropdownIconPreset,
  dropdownIconImageClassName,
  DropdownIconPreset,
} from './DropdownIconFrame';
import SectionToggleButton from './SectionToggleButton';
import SyncItemButton from './SyncItemButton';

interface BrowserCookiesSectionProps {
  isAvailable: boolean;
  expanded: boolean;
  onToggle: () => void;
  installedBrowsers: BrowserInfo[];
  connectedBrowsers: Set<BrowserType>;
  browserSyncLoading: BrowserType | null;
  onBrowserSync: (browserType: BrowserType) => void;
}

export function BrowserCookiesIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24">
      <defs>
        <radialGradient id="browserCookieGradient" cx="30%" cy="30%" r="70%">
          <stop offset="26%" stopColor="rgb(9,78,255)" />
          <stop offset="63%" stopColor="rgb(33,130,255)" />
          <stop offset="100%" stopColor="rgb(57,182,255)" />
        </radialGradient>
      </defs>
      <path
        fill="url(#browserCookieGradient)"
        d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"
      />
    </svg>
  );
}

function DesktopOnlyFallback() {
  return (
    <div className="flex items-center justify-between flex-wrap gap-2 p-4 border border-border rounded-lg bg-card/60">
      <div className="flex items-center gap-3">
        <DropdownIconFrame {...DropdownIconPreset.browserMain}>
          <BrowserCookiesIcon />
        </DropdownIconFrame>
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <h3 className="font-medium">Browser Cookies</h3>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              Desktop Only
            </span>
          </div>
          <span className="text-xs text-muted-foreground">Enable web automation and browsing</span>
        </div>
      </div>
      <Button size="sm" variant="outline" asChild>
        <a href="/download">Download for Mac</a>
      </Button>
    </div>
  );
}

export default function BrowserCookiesSection({
  isAvailable,
  expanded,
  onToggle,
  installedBrowsers,
  connectedBrowsers,
  browserSyncLoading,
  onBrowserSync,
}: BrowserCookiesSectionProps) {
  if (!isAvailable) {
    return <DesktopOnlyFallback />;
  }

  return (
    <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
      <div className="p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <DropdownIconFrame
            {...DropdownIconPreset.browserMain}
            isSynced={connectedBrowsers.size > 0}
          >
            <BrowserCookiesIcon />
          </DropdownIconFrame>
          <div className="flex flex-col">
            <h3 className="font-medium">Browser Cookies</h3>
            <span className="text-xs text-muted-foreground">
              Enable web automation and browsing
            </span>
          </div>
        </div>

        <SectionToggleButton
          isConnected={connectedBrowsers.size > 0}
          onClick={onToggle}
          sectionLabel="Browser Cookies"
        />
      </div>

      {expanded && (
        <div className="border-t border-border">
          {installedBrowsers.length === 0 ? (
            <div className="px-4 py-3 text-xs text-muted-foreground">
              No supported browsers detected. Install Chrome, Edge, Brave, Arc, or another
              Chromium-based browser.
            </div>
          ) : (
            installedBrowsers.map((browser, index) => (
              <div
                key={browser.type}
                className={`px-4 py-2 flex items-center justify-between ${
                  index < installedBrowsers.length - 1 ? 'border-b border-border/50' : ''
                }`}
              >
                <div className="flex items-center gap-3">
                  <DropdownIconFrame
                    {...BrowserDropdownIconPreset(browser.type)}
                    isSynced={connectedBrowsers.has(browser.type)}
                  >
                    <BrowserIcon type={browser.type} className={dropdownIconImageClassName} />
                  </DropdownIconFrame>
                  <div className="flex min-w-0 items-center">
                    <span className="truncate text-sm">{browser.name}</span>
                  </div>
                </div>

                <SyncItemButton
                  isLoading={browserSyncLoading === browser.type}
                  isSynced={connectedBrowsers.has(browser.type)}
                  onClick={() => onBrowserSync(browser.type)}
                />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
