/**
 * ConnectivityIndicator — bottom-left chip when WiFi / network is down.
 *
 * State machine:
 *   online ──offline event──▶ offline (chip visible)
 *   offline ──online event──▶ online (chip hidden)
 *
 * Reuses the shared bottom-left chip portal + styling from UpdateIndicator.
 */

import { createPortal } from 'react-dom';
import { useBottomLeftChipPortal } from '../../../shared/bottom-left-chips/hooks';
import { useConnectivityStatus } from '../hooks';
import { WifiOffIcon } from './WifiOffIcon';

const OFFLINE_CHIP =
  'flex items-center rounded-full bg-red-50 border border-red-200 px-3 py-1.5 shadow-sm gap-2 dark:bg-red-900/20 dark:border-red-800';
const OFFLINE_LABEL = 'text-xs font-medium text-red-700 dark:text-red-400';

export default function ConnectivityIndicator(): React.ReactElement | null {
  const { isOnline } = useConnectivityStatus();
  const container = useBottomLeftChipPortal();

  if (isOnline) return null;

  return createPortal(
    <div className="pointer-events-none">
      <div className={OFFLINE_CHIP}>
        <WifiOffIcon />
        <span className={OFFLINE_LABEL}>No connection</span>
      </div>
    </div>,
    container
  );
}
