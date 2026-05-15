import { useState, useMemo } from 'react';

import type { BrowserType } from '@/features/integration-handlers-context';

interface SyncHandlers {
  handleBrowserSync: (browserType: BrowserType) => Promise<void>;
  handleChromePasswordsSync: () => Promise<void>;
  handleApplePasswordsSync: (file: File) => Promise<number | undefined>;
  handleAtlasPasswordsSync: (keychainPassword: string) => Promise<void>;
  handlePasswordRequest: () => Promise<true | undefined>;
  handleClaudeCodeSync: () => Promise<void>;
  handleGptCodeSync: () => Promise<void>;
  handleIMessageSync: () => Promise<void>;
  handleLinkedInSync: () => Promise<void>;
  handleEmailConnect: (provider: 'gmail') => Promise<void>;
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
      onApplePasswordsSync: async (file: File) => {
        setError(null);
        const count = await h.handleApplePasswordsSync(file);
        if (count !== undefined) setSuccess(`Imported ${count} passwords from Apple Passwords`);
      },
      onAtlasPasswordsSync: async (pw: string) => {
        setError(null);
        await h.handleAtlasPasswordsSync(pw);
        setSuccess('Synced passwords from ChatGPT Atlas');
      },
      onPasswordRequest: async () => {
        setError(null);
        try {
          if (await h.handlePasswordRequest())
            setSuccess("Request sent! We'll add the integration within 24 hours.");
        } catch (e) {
          setError(formatError(e, 'Failed to send request'));
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
