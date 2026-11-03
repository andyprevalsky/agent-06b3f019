import { useEffect } from 'react';
import { readBrowserControlState, takeBrowserControl } from '@/lib/api';

export interface SessionOverride {
  taskId: string;
  resumedFromDisconnected?: boolean;
}

export function useBrowserControlRecovery(
  taskId: string,
  activeUserControl: SessionOverride | null,
  setResumedSession: (session: SessionOverride) => void,
  setUserControl: (session: SessionOverride | null) => void,
  readOnly: boolean,
): void {
  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;
    const reconcile = async () => {
      try {
        let snapshot = await readBrowserControlState(taskId);
        if (cancelled) return;
        if (snapshot.state === 'requested') snapshot = await takeBrowserControl(taskId);
        if (!cancelled && snapshot.state === 'user') {
          if (snapshot.debugUrl === null || snapshot.debugUrl === '') return;
          if (snapshot.agentPaused) {
            setResumedSession({ taskId, resumedFromDisconnected: true });
          }
          setUserControl({ taskId, resumedFromDisconnected: snapshot.agentPaused });
        }
      } catch (error) {
        console.error('Failed to reconcile browser control ownership:', error);
      }
    };
    const onControlChanged = (event: Event) => {
      if ((event as CustomEvent<{ taskId: string }>).detail?.taskId === taskId) {
        void reconcile();
      }
    };
    window.addEventListener('rose-browser-control-changed', onControlChanged);
    void reconcile();
    return () => {
      cancelled = true;
      window.removeEventListener('rose-browser-control-changed', onControlChanged);
    };
  }, [readOnly, setResumedSession, setUserControl, taskId]);

  useEffect(() => {
    if (readOnly || activeUserControl === null) return undefined;
    const timer = window.setInterval(() => {
      void takeBrowserControl(taskId).catch((error) => {
        console.error('Failed to renew browser control lease:', error);
        setUserControl(null);
      });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [activeUserControl, readOnly, setUserControl, taskId]);
}
