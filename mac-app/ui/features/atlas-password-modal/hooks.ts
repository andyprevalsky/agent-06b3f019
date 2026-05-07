/**
 * Business-logic hook for the atlas-password-modal feature.
 *
 * Owns the modal's local state machine (idle → ready → loading → error)
 * and the IPC handoff to `openKeychainAccess`. The component reads from
 * this hook and renders — it does not own any state itself.
 */

import { useState } from 'react';
import { getErrorMessageOrFallback } from '../../../shared/utils/error';
import { openAtlasKeychainEntry } from './api';
import type { AtlasPasswordSyncType, UseAtlasPasswordModalResult } from './types';

interface UseAtlasPasswordModalArgs {
  onClose: () => void;
  onSync: (password: string) => Promise<void>;
  syncType: AtlasPasswordSyncType;
}

export const useAtlasPasswordModal = ({
  onClose,
  onSync,
  syncType,
}: UseAtlasPasswordModalArgs): UseAtlasPasswordModalResult => {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);

  const handleOpenKeychain = async (): Promise<void> => {
    try {
      await openAtlasKeychainEntry();
    } catch (err) {
      console.error('Failed to open Keychain Access:', err);
    }
  };

  const handleSync = async (): Promise<void> => {
    // Re-entry guard: rapid double-submit (click+click or Enter+Enter in the same tick)
    // can fire handleSync twice before React flushes the disabled state.
    if (loading) return;

    if (password.trim() === '') {
      setError('Please enter the keychain password');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await onSync(password);
      // Success - modal will be closed by parent
    } catch (err) {
      setError(getErrorMessageOrFallback(err, `Failed to sync ${syncType}`));
      setLoading(false);
    }
  };

  const handleClose = (): void => {
    if (!loading) {
      setPassword('');
      setError(null);
      onClose();
    }
  };

  return {
    password,
    loading,
    error,
    expandedImage,
    setPassword,
    setExpandedImage,
    handleOpenKeychain,
    handleSync,
    handleClose,
  };
};
