import { useEffect, useMemo } from 'react';
import { CHIP_SLOT, PORTAL_ID } from './config';

let portalConsumerCount = 0;

/**
 * Shared portal root for bottom-left status chips. Multiple features portal
 * sibling chips into the same container; cleanup removes the node only when
 * the last consumer unmounts.
 */
export const useBottomLeftChipPortal = (): HTMLElement => {
  const container = useMemo(() => {
    const existing = document.getElementById(PORTAL_ID);
    if (existing !== null) return existing;

    const node = document.createElement('div');
    node.id = PORTAL_ID;
    node.className = CHIP_SLOT;
    document.body.appendChild(node);
    return node;
  }, []);

  useEffect(() => {
    portalConsumerCount += 1;
    return () => {
      portalConsumerCount -= 1;
      if (portalConsumerCount === 0) {
        const node = document.getElementById(PORTAL_ID);
        if (node !== null) node.remove();
      }
    };
  }, []);

  return container;
};
