import { useState, useEffect, useCallback } from 'react';

import type { useIntegrationHandlers } from '@/features/integration-handlers-context';

export function useComputeSync(
  handlers: ReturnType<typeof useIntegrationHandlers>,
  fetchIntegrations: () => Promise<void>,
) {
  const [claudeCodeSyncLoading, setClaudeCodeSyncLoading] = useState(false);
  const [gptCodeSyncLoading, setGptCodeSyncLoading] = useState(false);
  const [claudeCodeStatus, setClaudeCodeStatus] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).api;
    if (!api?.onClaudeSetupStatus) return;
    const cleanup = api.onClaudeSetupStatus((status: string) => {
      setClaudeCodeStatus(status || null);
    });
    return cleanup;
  }, []);

  const handleClaudeCodeSync = useCallback(async () => {
    if (!handlers.claudeCode) return;
    setClaudeCodeSyncLoading(true);
    try {
      const result = await handlers.claudeCode.syncCredentials();
      if (!result.success) {
        throw new Error(result.message || 'Failed to sync Claude Code credentials');
      }
      await fetchIntegrations();
    } finally {
      setClaudeCodeSyncLoading(false);
    }
  }, [handlers.claudeCode, fetchIntegrations]);

  const handleGptCodeSync = useCallback(async () => {
    if (!handlers.gptCode) return;
    setGptCodeSyncLoading(true);
    try {
      const result = await handlers.gptCode.syncCredentials();
      if (!result.success) {
        throw new Error(result.message || 'Failed to sync GPT credentials');
      }
      await fetchIntegrations();
    } finally {
      setGptCodeSyncLoading(false);
    }
  }, [handlers.gptCode, fetchIntegrations]);

  return {
    claudeCodeSyncLoading,
    gptCodeSyncLoading,
    claudeCodeStatus,
    handleClaudeCodeSync,
    handleGptCodeSync,
  } as const;
}
