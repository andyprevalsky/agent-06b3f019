/**
 * useVideoWatchdog — debug-only freeze detector. Polls every 300 ms while the
 * video is playing and attempts a micro-seek + pause/play + GPU-rebind when
 * the presentation clock stalls.
 */

import { useEffect, type RefObject } from 'react';

interface VideoQualityCaps extends HTMLVideoElement {
  getVideoPlaybackQuality?: () => { totalVideoFrames?: number; droppedVideoFrames?: number };
  webkitDecodedFrameCount?: number;
  webkitDroppedFrameCount?: number;
}

function tryMicroSeek(v: HTMLVideoElement): void {
  try {
    v.currentTime = Math.min((v.currentTime || 0) + 0.033, (v.duration || 0) - 0.001);
    v.playbackRate = 1.0;
    v.play().catch(() => {});
  } catch {
    // ignore — seek can throw pre-metadata
  }
}

function tryPauseAndReplay(v: HTMLVideoElement): void {
  try {
    v.pause();
    setTimeout(() => {
      try {
        void v.play();
      } catch {
        // ignore
      }
    }, 60);
  } catch {
    // ignore
  }
}

function tryGpuRebind(v: HTMLVideoElement): void {
  try {
    const prevWill = v.style.willChange || '';
    const prevTrans = v.style.transform || '';
    v.style.willChange = 'transform';
    v.style.transform = `${prevTrans} scale(1.0001)`;
    setTimeout(() => {
      try {
        v.style.transform = prevTrans;
        v.style.willChange = prevWill;
      } catch {
        // ignore
      }
    }, 120);
  } catch {
    // ignore
  }
}

function runWatchdog(
  v: VideoQualityCaps,
  lastCurrentTimeRef: { current: number },
  freezeReportedUntilRef: { current: number },
): void {
  const now = Date.now();
  const t = v.currentTime;
  const shouldBePlaying = !v.paused && !v.seeking && v.playbackRate > 0.0;
  if (!shouldBePlaying) {
    lastCurrentTimeRef.current = t;
    return;
  }
  const ctStalled = Math.abs(t - lastCurrentTimeRef.current) < 0.001;
  if (ctStalled && now > freezeReportedUntilRef.current) {
    freezeReportedUntilRef.current = now + 2000;
    tryMicroSeek(v);
    tryPauseAndReplay(v);
    tryGpuRebind(v);
  }
  lastCurrentTimeRef.current = t;
}

export function useVideoWatchdog(
  videoRef: RefObject<HTMLVideoElement | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return;
    const lastCurrentTimeRef = { current: 0 };
    const freezeReportedUntilRef = { current: 0 };
    const id = setInterval(() => {
      const v = videoRef.current as VideoQualityCaps | null;
      if (!v) return;
      runWatchdog(v, lastCurrentTimeRef, freezeReportedUntilRef);
    }, 300);
    return () => clearInterval(id);
  }, [videoRef, enabled]);
}
