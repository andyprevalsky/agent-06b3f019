/**
 * useStageControls — bundles the per-instance control flags (HEVC mode,
 * iOS-Safari, ramp-disabled, warmup-disabled, memory-offset frames) as stable
 * refs so the state-machine, debug-flags and prefetch hooks can share them.
 */

import { useRef, type MutableRefObject } from 'react';

export interface StageControlRefs {
  isHevcRef: MutableRefObject<boolean>;
  isIOSSafariRef: MutableRefObject<boolean>;
  disableRampRef: MutableRefObject<boolean>;
  disableWarmupRef: MutableRefObject<boolean>;
  memoryOffsetFramesRef: MutableRefObject<number>;
}

export function useStageControls(): StageControlRefs {
  return {
    isHevcRef: useRef(false),
    isIOSSafariRef: useRef(false),
    disableRampRef: useRef(false),
    disableWarmupRef: useRef(false),
    memoryOffsetFramesRef: useRef(2),
  };
}
