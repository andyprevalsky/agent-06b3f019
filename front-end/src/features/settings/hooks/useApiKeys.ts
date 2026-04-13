import { useState, useCallback } from 'react';

import { generateApiKeyApi, deleteApiKeyApi } from '../api';

interface ApiKeysResult {
  generatingKey: boolean;
  newKeyName: string;
  setNewKeyName: (v: string) => void;
  showNewKeyForm: boolean;
  setShowNewKeyForm: (v: boolean) => void;
  newlyGeneratedKey: string | null;
  setNewlyGeneratedKey: (v: string | null) => void;
  showSubscriptionModal: boolean;
  setShowSubscriptionModal: (v: boolean) => void;
  deletingKeyId: string | null;
  handleGenerateKeyClick: () => void;
  generateApiKey: () => Promise<void>;
  deleteApiKey: (keyId: string) => Promise<void>;
  copyToClipboard: (text: string) => void;
}

/** Manages API key CRUD and subscription-gate modal. */
export function useApiKeys(
  subscriptionTier: number | null,
  reloadApiKeys: () => Promise<void>,
  setError: (e: string | null) => void,
): ApiKeysResult {
  const [generatingKey, setGeneratingKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [showNewKeyForm, setShowNewKeyForm] = useState(false);
  const [newlyGeneratedKey, setNewlyGeneratedKey] = useState<string | null>(null);
  const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);
  const [deletingKeyId, setDeletingKeyId] = useState<string | null>(null);

  const handleGenerateKeyClick = useCallback(() => {
    if (subscriptionTier === null) {
      setShowSubscriptionModal(true);
    } else {
      setShowNewKeyForm(true);
    }
  }, [subscriptionTier]);

  const generateApiKey = useCallback(async () => {
    try {
      setGeneratingKey(true);
      const data = await generateApiKeyApi(newKeyName || null);
      setNewlyGeneratedKey(data.apiKey);
      setNewKeyName('');
      setShowNewKeyForm(false);
      await reloadApiKeys();
    } catch (err) {
      console.error('Failed to generate API key:', err);
      setError(err instanceof Error ? err.message : 'Failed to generate API key');
    } finally {
      setGeneratingKey(false);
    }
  }, [newKeyName, reloadApiKeys, setError]);

  const deleteApiKey = useCallback(
    async (keyId: string) => {
      try {
        setDeletingKeyId(keyId);
        await deleteApiKeyApi(keyId);
        await reloadApiKeys();
      } catch {
        console.error('Failed to delete API key');
      } finally {
        setDeletingKeyId(null);
      }
    },
    [reloadApiKeys],
  );

  const copyToClipboard = useCallback((text: string) => {
    void navigator.clipboard.writeText(text);
  }, []);

  return {
    generatingKey,
    newKeyName,
    setNewKeyName,
    showNewKeyForm,
    setShowNewKeyForm,
    newlyGeneratedKey,
    setNewlyGeneratedKey,
    showSubscriptionModal,
    setShowSubscriptionModal,
    deletingKeyId,
    handleGenerateKeyClick,
    generateApiKey,
    deleteApiKey,
    copyToClipboard,
  };
}
