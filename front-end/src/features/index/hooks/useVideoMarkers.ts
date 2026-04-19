/**
 * useVideoMarkers — loads `navi-features-markers.json` once on mount and
 * returns the raw + normalized shapes.
 */

import { useEffect, useMemo, useState } from 'react';

import { fetchMarkers } from '../api';
import type { MarkersFile } from '../types';
import { normalizeMarkers } from './stage-helpers';

export function useVideoMarkers(): {
  markers: MarkersFile | null;
  normalized: MarkersFile | null;
} {
  const [markers, setMarkers] = useState<MarkersFile | null>(null);

  useEffect(() => {
    let aborted = false;
    fetchMarkers()
      .then((data) => {
        if (!aborted) setMarkers(data);
      })
      .catch(() => {
        // non-fatal — stage will simply not start its state machine
      });
    return () => {
      aborted = true;
    };
  }, []);

  const normalized = useMemo(() => normalizeMarkers(markers), [markers]);
  return { markers, normalized };
}
