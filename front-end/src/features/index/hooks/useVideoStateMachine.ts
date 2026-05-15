/**
 * useVideoStateMachine — drives the FeatureVideoStage playback/seek logic via
 * requestVideoFrameCallback (or requestAnimationFrame as a fallback).
 *
 * Mode transitions are delegated to `state-machine.ts`; this hook owns only
 * the React-level wiring (refs, effect lifetime, listeners).
 */

import { useEffect, useRef, type RefObject } from 'react';

import { mapIndexToKey } from '../config';
import type { FeatureKey, MarkersFile } from '../types';
import type { CustomPlan, StageMode } from './stage-helpers';
import { runTick, type MachineRefs } from './stage-state-machine';

interface RVFCVideo extends HTMLVideoElement {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime?: number }) => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
}

export interface VideoStateMachineConfig {
  videoRef: RefObject<HTMLVideoElement | null>;
  activeIndex: number;
  normalized: MarkersFile | null;
  isHevcRef: RefObject<boolean>;
  isIOSSafariRef: RefObject<boolean>;
  disableRampRef: RefObject<boolean>;
  memoryOffsetFramesRef: RefObject<number>;
}

export function useVideoStateMachine(cfg: VideoStateMachineConfig): void {
  const activeKeyRef = useRef<FeatureKey | null>(null);
  const modeRef = useRef<StageMode>('idle');
  const rampStartMsRef = useRef(0);
  const stopAtRef = useRef(0);
  const targetKeyRef = useRef<FeatureKey | null>(null);
  const verifyAfterSeekRef = useRef<FeatureKey | null>(null);
  const seekRetryRef = useRef(0);
  const customPlanRef = useRef<CustomPlan | null>(null);

  // Target switches: just set a ref — the per-frame loop reacts to it.
  useEffect(() => {
    targetKeyRef.current = mapIndexToKey(cfg.activeIndex);
  }, [cfg.activeIndex]);

  useEffect(() => {
    const v = cfg.videoRef.current as RVFCVideo | null;
    if (!v || !cfg.normalized) return;

    const refs: MachineRefs = {
      activeKey: activeKeyRef,
      mode: modeRef,
      rampStartMs: rampStartMsRef,
      stopAt: stopAtRef,
      targetKey: targetKeyRef,
      verifyAfterSeek: verifyAfterSeekRef,
      seekRetry: seekRetryRef,
      customPlan: customPlanRef,
      isHevc: cfg.isHevcRef,
      isIOSSafari: cfg.isIOSSafariRef,
      disableRamp: cfg.disableRampRef,
      memoryOffsetFrames: cfg.memoryOffsetFramesRef,
    };

    let scheduled = false;
    let rafId: number | null = null;
    let vfcId: number | null = null;

    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      const rvfc =
        typeof v.requestVideoFrameCallback === 'function'
          ? v.requestVideoFrameCallback.bind(v)
          : null;
      if (rvfc) {
        vfcId = rvfc((_now, meta) => {
          scheduled = false;
          if (!cfg.normalized) return;
          runTick(v, cfg.normalized, refs, schedule, meta?.mediaTime);
        });
      } else {
        rafId = requestAnimationFrame(() => {
          scheduled = false;
          if (!cfg.normalized) return;
          runTick(v, cfg.normalized, refs, schedule);
        });
      }
    };

    const onTick = () => {
      if (!cfg.normalized) return;
      runTick(v, cfg.normalized, refs, schedule);
    };

    schedule();
    v.addEventListener('timeupdate', onTick);
    v.addEventListener('seeked', onTick);

    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
      if (vfcId != null && typeof v.cancelVideoFrameCallback === 'function') {
        try {
          v.cancelVideoFrameCallback(vfcId);
        } catch {
          // ignore — some engines throw if id already cancelled
        }
      }
      scheduled = false;
      v.removeEventListener('timeupdate', onTick);
      v.removeEventListener('seeked', onTick);
    };
  }, [
    cfg.videoRef,
    cfg.normalized,
    cfg.isHevcRef,
    cfg.isIOSSafariRef,
    cfg.disableRampRef,
    cfg.memoryOffsetFramesRef,
  ]);
}
