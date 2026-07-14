/**
 * STATE MACHINE: PasskeysConnectRow
 *
 * Parent password section:
 *   [COLLAPSED] --expand passwords--> [VISIBLE]
 *
 * Row action:
 *   [DESKTOP_UNAVAILABLE] --download--> [DOWNLOAD_PAGE]
 *   [READY] --sync icon--> parent opens [APPLE_CREDENTIAL_EXCHANGE_MODAL]
 *   [SYNCING] --done--> [READY|SYNCED]
 *   [SYNCED] --render--> [CHECKED]
 *
 * System context:
 *   Rose UI row -> Apple Passwords & Passkeys modal -> macOS AutoFill settings
 *     -> user exports Apple Passwords items to Rose -> native importer -> backend upload
 */

import { Button } from '@/components/ui/button';
import applePasswordsIcon from '@/assets/apple-passwords-icon.png';

import DropdownIconFrame, {
  dropdownIconImageClassName,
  DropdownIconPreset,
} from './DropdownIconFrame';
import SyncItemButton from './SyncItemButton';

interface PasskeysConnectRowProps {
  isAvailable: boolean;
  isSynced: boolean;
  isLoading: boolean;
  onConnect: () => void;
}

export default function PasskeysConnectRow({
  isAvailable,
  isSynced,
  isLoading,
  onConnect,
}: PasskeysConnectRowProps) {
  return (
    <div
      data-testid="passkeys-sync-row"
      className="px-4 py-2 flex items-center justify-between border-b border-border/50"
    >
      <div className="flex items-center gap-3">
        <DropdownIconFrame {...DropdownIconPreset.applePasswords} isSynced={isSynced}>
          <img
            src={applePasswordsIcon}
            alt=""
            aria-hidden="true"
            className={dropdownIconImageClassName}
          />
        </DropdownIconFrame>
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-sm">Apple Passwords &amp; Passkeys</span>
            {!isAvailable && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                Desktop Only
              </span>
            )}
          </div>
        </div>
      </div>
      {isAvailable ? (
        <SyncItemButton
          ariaLabel="Sync Apple Passwords and Passkeys"
          isLoading={isLoading}
          isSynced={isSynced}
          onClick={onConnect}
        />
      ) : (
        <Button size="sm" variant="outline" asChild>
          <a href="/download">Download for Mac</a>
        </Button>
      )}
    </div>
  );
}
