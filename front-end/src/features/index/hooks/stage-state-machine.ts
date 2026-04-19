/**
 * FeatureVideoStage state-machine implementation.
 *
 * Kept as plain (framework-free) functions that mutate the refs passed in so
 * the React hook stays small and testable. The main entry is `runTick`.
 */

import type { FeatureKey, MarkersFile } from '../types';
import {
  buildCustomWindows,
  computeSeekForKey,
  findContainingFeature,
  type CustomPlan,
  type StageMode,
} from './stage-helpers';

export interface MachineRefs {
  activeKey: { current: FeatureKey | null };
  mode: { current: StageMode };
  rampStartMs: { current: number };
  stopAt: { current: number };
  targetKey: { current: FeatureKey | null };
  verifyAfterSeek: { current: FeatureKey | null };
  seekRetry: { current: number };
  customPlan: { current: CustomPlan | null };
  isHevc: { current: boolean };
  isIOSSafari: { current: boolean };
  disableRamp: { current: boolean };
  memoryOffsetFrames: { current: number };
}

interface TickContext {
  video: HTMLVideoElement;
  normalized: MarkersFile;
  refs: MachineRefs;
  schedule: () => void;
}

function computeSeek(refs: MachineRefs, normalized: MarkersFile, key: FeatureKey | null, baseTime: number): number {
  return computeSeekForKey({
    key,
    baseTime,
    fps: normalized.fps || 30,
    isIOSSafari: refs.isIOSSafari.current,
    memoryOffsetFrames: refs.memoryOffsetFrames.current,
  });
}

function startRampOrSeek(ctx: TickContext, requested: FeatureKey, where: { key: FeatureKey; part: string }) {
  const { refs, normalized } = ctx;
  const targetSeg = normalized[requested];
  if (where.part === 'cycle' || where.part === 'outro') {
    refs.mode.current = 'ramping';
    refs.rampStartMs.current = performance.now();
    refs.stopAt.current = normalized[where.key].outroEnd;
  } else {
    void targetSeg;
    refs.mode.current = 'seeking';
  }
}

function handleRamping(ctx: TickContext, t: number, where: { key: FeatureKey; part: string }) {
  const { video, refs, normalized } = ctx;
  const eps = Math.max(0.005, (1 / (normalized.fps || 30)) * 0.9);
  const k = Math.min((performance.now() - refs.rampStartMs.current) / 1000, 1);
  const maxRate = refs.isHevc.current ? 2 : 4;
  const desiredRate = 1 + (maxRate - 1) * k;
  const curSeg = normalized[where.key];
  if (t >= curSeg.outroStart - eps) {
    video.playbackRate = 1.0;
  } else {
    video.playbackRate = refs.disableRamp.current ? 1.0 : desiredRate;
  }
  if (t >= refs.stopAt.current - eps) {
    video.playbackRate = 1.0;
    refs.mode.current = 'seeking';
  }
}

function handleCustomAwait(ctx: TickContext, t: number, requested: FeatureKey) {
  const { video, refs, normalized } = ctx;
  const plan = refs.customPlan.current;
  if (!plan) return;
  void requested;
  video.playbackRate = 1.0;
  const fps = normalized.fps || 30;
  const chosen = plan.windows.find((w) => t >= w.start / fps && t <= w.end / fps);
  if (!chosen) return;
  const { mStart, mEnd } = chosen;
  if (mStart == null || mEnd == null) return;
  plan.chosen = {
    validStart: chosen.start,
    validEnd: chosen.end,
    outroStart: mStart,
    outroEnd: mEnd,
  };
  video.playbackRate = 1.0;
  video.currentTime = mStart + 0.001;
  try {
    void video.play();
  } catch {
    // ignore play rejections (user gesture / blocked autoplay)
  }
  refs.mode.current = 'customOutroPlaying';
}

function handleCustomOutroPlaying(ctx: TickContext, t: number) {
  const { refs, normalized } = ctx;
  const plan = refs.customPlan.current;
  if (!plan) return;
  const eps = Math.max(0.005, (1 / (normalized.fps || 30)) * 0.9);
  const end = plan.chosen?.outroEnd ?? Number.POSITIVE_INFINITY;
  if (t >= end - eps) refs.mode.current = 'seeking';
}

function commitSeek(ctx: TickContext, requested: FeatureKey, desired: number) {
  const { video, refs } = ctx;
  video.currentTime = desired;
  try {
    void video.play();
  } catch {
    // ignore — play() rejection is non-fatal
  }
  refs.activeKey.current = requested;
  refs.targetKey.current = null;
  refs.mode.current = 'idle';
  refs.customPlan.current = null;
  refs.verifyAfterSeek.current = requested;
  refs.seekRetry.current = 0;
}

function handleSeeking(ctx: TickContext, requested: FeatureKey) {
  const { video, refs, normalized, schedule } = ctx;
  video.playbackRate = 1.0;
  const targetSeg = normalized[requested];
  const isNearZero = targetSeg.introStart <= 0.01;
  if (isNearZero && refs.isHevc.current) {
    const onLoaded = () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      commitSeek(ctx, requested, 0.0);
      schedule();
    };
    video.addEventListener('loadedmetadata', onLoaded, { once: true });
    try {
      video.load();
    } catch {
      // ignore — load() can throw in some engines
    }
    return;
  }
  const baseDesired = isNearZero ? 0.0 : targetSeg.introStart + 0.001;
  const desired = computeSeek(refs, normalized, requested, baseDesired);
  commitSeek(ctx, requested, desired);
  schedule();
}

function maybeActivateCustomAwait(ctx: TickContext, where: { key: FeatureKey }, requested: FeatureKey) {
  const { refs, normalized } = ctx;
  if (where.key !== 'customization' || requested === 'customization') return;
  const cur = refs.mode.current;
  if (cur === 'customAwaitWindow' || cur === 'customOutroPlaying') return;
  refs.customPlan.current = {
    windows: buildCustomWindows(normalized.customization),
    targetKey: requested,
  };
  refs.mode.current = 'customAwaitWindow';
}

function handleTargetRequested(ctx: TickContext, t: number) {
  const requested = ctx.refs.targetKey.current;
  if (!requested) return;
  const where = findContainingFeature(ctx.normalized, t);
  maybeActivateCustomAwait(ctx, where, requested);
  if (ctx.refs.mode.current === 'idle') startRampOrSeek(ctx, requested, where);
  if (ctx.refs.mode.current === 'ramping') handleRamping(ctx, t, where);
  if (ctx.refs.mode.current === 'customAwaitWindow') handleCustomAwait(ctx, t, requested);
  if (ctx.refs.mode.current === 'customOutroPlaying') handleCustomOutroPlaying(ctx, t);
  if (ctx.refs.mode.current === 'seeking') handleSeeking(ctx, requested);
}

function verifyIntroLanding(ctx: TickContext, t: number): 'continue' | 'waiting' {
  const { video, refs, normalized } = ctx;
  const key = refs.activeKey.current;
  if (!key) return 'continue';
  if (refs.verifyAfterSeek.current !== key) return 'continue';
  const seg = normalized[key];
  const eps = Math.max(0.005, (1 / (normalized.fps || 30)) * 0.9);
  if (t < seg.introStart - eps) return 'waiting';
  if (t <= seg.introEnd - eps) {
    refs.verifyAfterSeek.current = null;
    return 'continue';
  }
  // Past intro — one retry
  if (refs.seekRetry.current < 1) {
    const baseDesired = seg.introStart <= 0.01 ? 0.0 : seg.introStart + 0.001;
    const desired = computeSeek(refs, normalized, key, baseDesired);
    video.currentTime = desired;
    try {
      void video.play();
    } catch {
      // ignore — play() rejection is non-fatal on retry
    }
    refs.seekRetry.current += 1;
    return 'waiting';
  }
  refs.verifyAfterSeek.current = null;
  return 'continue';
}

function maybeLoopCycle(ctx: TickContext, t: number) {
  const { video, refs, normalized } = ctx;
  if (refs.mode.current !== 'idle') return;
  const key = refs.activeKey.current;
  if (!key || refs.verifyAfterSeek.current) return;
  const seg = normalized[key];
  const eps = Math.max(0.005, (1 / (normalized.fps || 30)) * 0.9);
  if (t < seg.cycleEnd - eps) return;
  const desired = computeSeek(refs, normalized, key, seg.cycleStart + 0.001);
  video.currentTime = desired;
  try {
    void video.play();
  } catch {
    // ignore
  }
}

/** Advance the state machine by one video frame. Called from RVFC/RAF. */
export function runTick(
  video: HTMLVideoElement,
  normalized: MarkersFile,
  refs: MachineRefs,
  schedule: () => void,
  mediaTime?: number,
): void {
  const t = typeof mediaTime === 'number' ? mediaTime : video.currentTime;
  const ctx: TickContext = { video, normalized, refs, schedule };
  handleTargetRequested(ctx, t);
  const verify = verifyIntroLanding(ctx, t);
  if (verify === 'waiting') {
    schedule();
    return;
  }
  maybeLoopCycle(ctx, t);
  schedule();
}
