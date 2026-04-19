/**
 * useVideoDebugFlags — reads debug flags from URL query + localStorage (via
 * `@/lib/url` and `@/lib/storage`) and writes them to the provided control
 * refs. Returns the computed `debugEnabled` flag so the watchdog hook can
 * decide whether to arm.
 */

import { useEffect, useState, type MutableRefObject } from 'react';

import { readDebugFlags } from './stage-debug-flags';

export interface VideoDebugFlagsOptions {
  disableRampRef: MutableRefObject<boolean>;
  disableWarmupRef: MutableRefObject<boolean>;
}

export function useVideoDebugFlags(options: VideoDebugFlagsOptions): boolean {
  const { disableRampRef, disableWarmupRef } = options;
  const [debugEnabled, setDebugEnabled] = useState(false);

  useEffect(() => {
    const flags = readDebugFlags();
    disableRampRef.current = flags.disableRamp;
    disableWarmupRef.current = flags.disableWarmup;
    setDebugEnabled(flags.debugEnabled);
  }, [disableRampRef, disableWarmupRef]);

  return debugEnabled;
}
