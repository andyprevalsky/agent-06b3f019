/**
 * MOUNT -> load list; SETTING_UP -> bounded refresh -> CONNECTED | FAILED.
 * Add -> POST with stable retry key -> backend-owned setup state -> focus setup agent.
 * Unmount stops polling. Agent lifecycle never implies verified connection.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { openAgentInCurrentClient } from '@/lib/openAgent';
import { connectCli, fetchCliIntegrations, type CliIntegration } from '../api/cli';
import { useSyncRefresh } from './useSyncProgress';

export const CLI_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_COUNT = 360;

export function useCliIntegrations() {
  const [integrations, setIntegrations] = useState<CliIntegration[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pollCount, setPollCount] = useState(0);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const pending = useRef(false);
  const revision = useRef(0);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const requestRevision = revision.current;
    setLoading(true);
    try {
      const rows = await fetchCliIntegrations();
      if (mounted.current && requestRevision === revision.current) {
        setIntegrations(rows);
        setError(null);
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not load CLIs');
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const settingUp = integrations.some((row) => row.status === 'setting_up');
  useSyncRefresh(settingUp && pollCount < MAX_POLL_COUNT, CLI_POLL_INTERVAL_MS, () => {
    setPollCount((count) => count + 1);
    void refresh();
  });

  const connect = async (request: string, requestId: string): Promise<boolean> => {
    if (pending.current) return false;
    pending.current = true;
    revision.current += 1;
    setSubmitting(true);
    setError(null);
    try {
      const row = await connectCli(request, requestId);
      if (mounted.current) {
        setIntegrations((rows) => [...rows.filter((item) => item.id !== row.id), row]);
        setPollCount(0);
        if (row.status === 'setting_up' && row.agent_id) openAgentInCurrentClient(row.agent_id);
      }
      return true;
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : 'Could not connect CLI');
      return false;
    } finally {
      pending.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  return { integrations, error, loading, submitting, connect, refresh };
}
