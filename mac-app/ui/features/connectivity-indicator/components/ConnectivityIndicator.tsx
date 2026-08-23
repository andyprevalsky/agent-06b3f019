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
import { CHIP_BASE, CHIP_LABEL } from '../../bottom-left-chips/config';
import { useBottomLeftChipPortal } from '../../bottom-left-chips/hooks';
import { WarningIcon } from '../../update-indicator/components/Icons';
import { useConnectivityStatus } from '../hooks';

export default function ConnectivityIndicator(): React.ReactElement | null {
  const { isOnline } = useConnectivityStatus();
  const container = useBottomLeftChipPortal();

  if (isOnline) return null;

  return createPortal(
    <div className="pointer-events-none">
      <div className={`${CHIP_BASE} gap-2`}>
        <WarningIcon />
        <span className={CHIP_LABEL}>No connection</span>
      </div>
    </div>,
    container
  );
}
