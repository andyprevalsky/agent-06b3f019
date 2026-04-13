import { useState, useEffect } from 'react';

export function useOAuthRedirect(fetchIntegrations: () => Promise<void>) {
  const [oauthSuccess, setOauthSuccess] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthResult = params.get('oauth_result');
    if (oauthResult) {
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, '', cleanUrl);

      if (oauthResult === 'success') {
        setOauthSuccess(params.get('message') || 'Email connected successfully.');
      } else {
        setOauthError(params.get('message') || 'Failed to connect email.');
      }
      void fetchIntegrations();
    }
  }, [fetchIntegrations]);

  return { oauthSuccess, oauthError } as const;
}
