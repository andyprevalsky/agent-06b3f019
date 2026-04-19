/**
 * Terminal feature — ancestor chain hook.
 *
 * Loads the ancestor (sub-agent) chain for the currently selected agent.
 */

import { useEffect, useState } from 'react';

import { fetchAncestors as fetchAncestorsAPI } from '../api';
import type { AncestorNode } from '../types';

export function useAncestors(selectedAgentId: string | null): AncestorNode[] {
  const [ancestors, setAncestors] = useState<AncestorNode[]>([]);

  useEffect(() => {
    if (!selectedAgentId) {
      setAncestors([]);
      return;
    }
    let active = true;
    fetchAncestorsAPI(selectedAgentId)
      .then((result) => {
        if (active) setAncestors(result);
      })
      .catch(() => {
        if (active) setAncestors([]);
      });
    return () => {
      active = false;
    };
  }, [selectedAgentId]);

  return ancestors;
}
