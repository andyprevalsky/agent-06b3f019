/**
 * ConnectivityIndicator domain blackbox tests — file-level boundary for
 * `mac-app/ui/ConnectivityIndicator.tsx`.
 *
 * Asserts navigator online/offline wiring, portal lifecycle via the shared
 * bottom-left chip container, and chip visibility when offline.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';

import { renderWithProviders } from './test-wrapper';
import ConnectivityIndicator from '../../ui/ConnectivityIndicator';
import UpdateIndicator from '../../ui/UpdateIndicator';
import { PORTAL_ID } from '../../ui/features/bottom-left-chips/config';
import { clearIpcMock, installIpcMock } from './ipc-mock';
import type { IPC, UpdateStatusPayload } from '../../shared/types/ipc';

const setNavigatorOnline = (online: boolean): void => {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => online,
  });
};

const emitOffline = (): void => {
  act(() => {
    window.dispatchEvent(new Event('offline'));
  });
};

const emitOnline = (): void => {
  act(() => {
    window.dispatchEvent(new Event('online'));
  });
};

afterEach(() => {
  cleanup();
  clearIpcMock();
  document.getElementById(PORTAL_ID)?.remove();
  setNavigatorOnline(true);
});

describe('ConnectivityIndicator — module boundary', () => {
  it('default-exports a React component', () => {
    expect(typeof ConnectivityIndicator).toBe('function');
  });

  it('renders nothing when navigator reports online', () => {
    setNavigatorOnline(true);
    renderWithProviders(<ConnectivityIndicator />);

    expect(screen.queryByText('No connection')).not.toBeInTheDocument();
  });

  it('shows the offline chip when navigator is offline on mount', () => {
    setNavigatorOnline(false);
    renderWithProviders(<ConnectivityIndicator />);

    expect(screen.getByText('No connection')).toBeInTheDocument();
  });

  it('shows the chip after an offline event and hides it on online', () => {
    setNavigatorOnline(true);
    renderWithProviders(<ConnectivityIndicator />);

    setNavigatorOnline(false);
    emitOffline();
    expect(screen.getByText('No connection')).toBeInTheDocument();

    setNavigatorOnline(true);
    emitOnline();
    expect(screen.queryByText('No connection')).not.toBeInTheDocument();
  });
});

describe('ConnectivityIndicator — portal lifecycle', () => {
  it('uses the shared #rose-bottom-left-chips portal root', () => {
    setNavigatorOnline(false);
    renderWithProviders(<ConnectivityIndicator />);

    const portal = document.getElementById(PORTAL_ID);
    expect(portal).toBeInstanceOf(HTMLDivElement);
    expect(portal?.className).toContain('bottom-6');
    expect(portal?.className).toContain('left-6');
  });

  it('stacks with UpdateIndicator in the same portal without duplicate roots', () => {
    setNavigatorOnline(false);

    const statusCallbacks: Array<(p: UpdateStatusPayload) => void> = [];
    installIpcMock({
      onUpdateStatus: (cb: (p: UpdateStatusPayload) => void) => {
        statusCallbacks.push(cb);
      },
      onUpdateProgress: () => {},
    } as Partial<IPC>);

    renderWithProviders(
      <>
        <UpdateIndicator />
        <ConnectivityIndicator />
      </>
    );

    act(() => {
      statusCallbacks.forEach((cb) => cb({ state: 'available', version: '9.9.9' }));
    });

    expect(document.querySelectorAll(`#${PORTAL_ID}`)).toHaveLength(1);
    expect(screen.getByText('New update available')).toBeInTheDocument();
    expect(screen.getByText('No connection')).toBeInTheDocument();
  });
});
