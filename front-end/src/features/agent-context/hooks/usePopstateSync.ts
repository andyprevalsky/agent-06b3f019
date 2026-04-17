import { useEffect } from 'react';

import { getQueryParams } from '@/lib/url';

export function usePopstateSync(
  selectedAgentId: string | null,
  setSelectedAgentId: (id: string | null) => void,
) {
  useEffect(() => {
    const handlePopState = () => {
      const params = getQueryParams();
      const urlAgentId = params.get('agent-id');

      if (urlAgentId !== selectedAgentId) {
        setSelectedAgentId(urlAgentId);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [selectedAgentId, setSelectedAgentId]);
}
