import { useEffect } from 'react';
import { dispatchQuickQueryEvent } from '@/lib/quickQuery';
import type { QuickQueryPayload } from '../../shared/types/ipc';
import { getElectronApi } from '../lib/electron-api';

export default function QuickQueryListener() {
  useEffect(() => {
    const handler = (payload: QuickQueryPayload) => {
      dispatchQuickQueryEvent(payload);
    };

    getElectronApi()?.onQuickQuerySubmit(handler);
  }, []);

  return null;
}
