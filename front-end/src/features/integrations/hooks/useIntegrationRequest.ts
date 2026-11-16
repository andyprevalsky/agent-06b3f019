/**
 * STATE MACHINE: useIntegrationRequest
 *
 *   [IDLE] --submit(text)--> [SENDING] (one request_id per draft; a retry reuses it)
 *     --ok--> [SENT] (shows the confirmation) | --refused--> [IDLE] + error
 *   editing the draft starts a new request_id
 */
import { useRef, useState } from 'react';

import { requestIntegration } from '../api/integrationRequest';

export function useIntegrationRequest() {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);

  const draftChanged = () => {
    requestId.current = null;
    setError(null);
  };

  const submit = async (text: string): Promise<boolean> => {
    const request = text.trim();
    if (request === '' || sending) return false;
    requestId.current ??= crypto.randomUUID();
    setSending(true);
    setError(null);
    try {
      await requestIntegration(request, requestId.current);
      requestId.current = null;
      setSent(request);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send your request');
      return false;
    } finally {
      setSending(false);
    }
  };

  return { sending, sent, error, submit, draftChanged, reset: () => setSent(null) };
}
