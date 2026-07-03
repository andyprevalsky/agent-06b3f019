import { useState, useMemo } from 'react';

import type { BrowserType } from '@/features/integration-handlers-context';

interface SyncHandlers {
  handleBrowserSync: (browserType: BrowserType) => Promise<void>;
  handleChromePasswordsSync: () => Promise<void>;
  handleAtlasPasswordsSync: (keychainPassword: string) => Promise<void>;
  handlePasskeysConnect: () => Promise<{
    enabled?: boolean;
    openedSettings?: boolean;
    openedPasswordsApp?: boolean;
  } | void>;
  handleClaudeCodeSync: () => Promise<void>;
  handleGptCodeSync: () => Promise<void>;
  handleIMessageSync: () => Promise<void>;
  handleLinkedInSync: () => Promise<void>;
  handleEmailConnect: (provider: 'gmail') => Promise<void>;
  handleEmailDisconnect: (email: string) => Promise<void>;
  handleFileUpload: (type: 'vcf' | 'email-zip', file: File) => Promise<string | undefined>;
}

function formatError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

type SetBanner = (msg: string | null) => void;

function wrapAction(fn: () => Promise<void>, setErr: SetBanner, fallback: string) {
  return async () => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(formatError(e, fallback));
    }
  };
}

export function useIntegrationActions(handlers: SyncHandlers) {
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const actions = useMemo(() => {
    const h = handlers;
    return {
      onBrowserSync: async (bt: BrowserType) => {
        setError(null);
        try {
          await h.handleBrowserSync(bt);
        } catch (e) {
          setError(formatError(e, `Failed to sync ${bt} cookies`));
        }
      },
      onChromePasswordsSync: wrapAction(
        h.handleChromePasswordsSync,
        setError,
        'Failed to sync Chrome passwords',
      ),
      onAtlasPasswordsSync: async (pw: string) => {
        setError(null);
        await h.handleAtlasPasswordsSync(pw);
        setSuccess('Synced passwords from ChatGPT Atlas');
      },
      onPasskeysConnect: async () => {
        setError(null);
        try {
          return await h.handlePasskeysConnect();
        } catch (e) {
          const message = formatError(e, 'Failed to sync passkeys');
          setError(message);
          throw new Error(message);
        }
      },
      onClaudeCodeSync: wrapAction(
        h.handleClaudeCodeSync,
        setError,
        'Failed to sync Claude Code credentials',
      ),
      onGptCodeSync: wrapAction(h.handleGptCodeSync, setError, 'Failed to sync GPT credentials'),
      onIMessageSync: wrapAction(h.handleIMessageSync, setError, 'Failed to sync iMessage'),
      onLinkedInSync: wrapAction(h.handleLinkedInSync, setError, 'Failed to start LinkedIn sync'),
      onGmailConnect: wrapAction(() => h.handleEmailConnect('gmail'), setError, 'Unknown error'),
      onGmailDisconnect: async (email: string) => {
        setError(null);
        try {
          await h.handleEmailDisconnect(email);
        } catch (e) {
          setError(formatError(e, 'Failed to disconnect Gmail account'));
        }
      },
      onFileChange: async (type: 'vcf' | 'email-zip', file: File) => {
        setError(null);
        setSuccess(null);
        try {
          const msg = await h.handleFileUpload(type, file);
          if (msg) setSuccess(msg);
        } catch (e) {
          setError(formatError(e, 'Unknown error'));
        }
      },
    };
  }, [handlers]);

  return { error, success, ...actions } as const;
}
