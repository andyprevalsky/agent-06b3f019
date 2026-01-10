/**
 * STATE MACHINE: FeatureVideoStage
 *
 * VIDEO PLAYBACK PHASES:
 * [LOADING] <-- canPlay: false, markersLoaded: false
 *     |
 *     v (video + markers loaded)
 * [INTRO] --> play intro segment for feature
 *     |
 *     v (intro ends)
 * [CYCLING] --> loop between cycleStart and cycleEnd
 *     |
 *     | (feature changes)
 *     v
 * [OUTRO] --> play outro segment
 *     |
 *     v (outro ends)
 * [INTRO] (for new feature)
 *
 * States:
 * - canPlay: boolean (video ready)
 * - markersLoaded: boolean (segment timestamps loaded)
 * - phase: 'intro' | 'cycle' | 'outro' | null
 * - showLoading: boolean (loading overlay visibility)
 */

import { useEffect, useMemo, useRef, useState } from "react";
import VideoLoadingAnimation from "./VideoLoadingAnimation";

type FeatureKey = "customization" | "conversations" | "engine" | "memory" | "privacy";

interface Segment {
  introStart: number;
  introEnd: number;
  cycleStart: number;
  cycleEnd: number;
  outroStart: number;
  outroEnd: number;
  // Customization-only optional specialized outros
  outroAnthropicStart?: number;
  outroAnthropicEnd?: number;
  outroGeminiStart?: number;
  outroGeminiEnd?: number;
  outroMetaStart?: number;
  outroMetaEnd?: number;
  outroDeepseakStart?: number;
  outroDeepseakEnd?: number;
}

interface MarkersFile {
  fps: number;
  customization: Segment;
  conversations: Segment;
  engine: Segment;
  memory: Segment;
  privacy: Segment;
}

interface FeatureVideoStageProps {
  activeIndex: number;
}

function mapIndexToKey(index: number): FeatureKey {
  // 0: customization, 1: conversations, 2: engine, 3: memory, 4: privacy
  switch (index) {
    case 0: return "customization";
    case 1: return "conversations";
    case 2: return "engine";
    case 3: return "memory";
    case 4: return "privacy";
    default: return "engine";
  }
}

function findContainingFeature(markers: MarkersFile, t: number): { key: FeatureKey; part: "intro" | "cycle" | "outro" | "none" } {
  const keys: FeatureKey[] = ["customization", "conversations", "engine", "memory", "privacy"];
  for (const key of keys) {
    const s = markers[key];
    if (t >= s.introStart && t < s.introEnd) return { key, part: "intro" };
    if (t >= s.introEnd && t < s.outroStart) return { key, part: "cycle" };
    if (t >= s.outroStart && t < s.outroEnd + 0.0001) return { key, part: "outro" };
  }
  return { key: "engine", part: "none" };
}

export default function FeatureVideoStage({ activeIndex }: FeatureVideoStageProps) {
  const MASTER_SRC_WEBM = "/navi-features.webm"; // cross-browser
  const MASTER_SRC_HEVC = "/navi-features-hevc.mov"; // Safari/iOS
  const [markers, setMarkers] = useState<MarkersFile | null>(null);
  const [isVideoLoading, setIsVideoLoading] = useState(true);
  const normalized = useMemo<MarkersFile | null>(() => {
    if (!markers) return null;
    return {
      fps: markers.fps,
      customization: markers.customization,
      conversations: markers.conversations,
      engine: markers.engine,
      memory: markers.memory,
      privacy: markers.privacy
    };
  }, [markers]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeKeyRef = useRef<FeatureKey | null>(null);
  const rafRef = useRef<number | null>(null);
  const vfcIdRef = useRef<number | null>(null);
  const scheduledRef = useRef<boolean>(false);
  const modeRef = useRef<"idle" | "ramping" | "awaitOutro" | "seeking" | "customAwaitWindow" | "customOutroPlaying">("idle");
  const rampStartMsRef = useRef<number>(0);
  const stopAtRef = useRef<number>(0);
  const targetKeyRef = useRef<FeatureKey | null>(null);
  const verifyAfterSeekRef = useRef<FeatureKey | null>(null);
  const seekRetryRef = useRef<number>(0);
  const lastPausedRef = useRef<boolean | null>(null);
  const customPlanRef = useRef<{
    windows: Array<{ name: 'anthropic' | 'meta' | 'deepseak' | 'gemini' | 'oai'; start: number; end: number; mStart?: number; mEnd?: number }>;
    targetKey: FeatureKey;
    chosen?: { validStart: number; validEnd: number; outroStart: number; outroEnd: number };
  } | null>(null);
  const lastTimeRef = useRef<number>(0);
  const blobUrlRef = useRef<string | null>(null);
  const isHevcRef = useRef<boolean>(false);
  const isIOSSafariRef = useRef<boolean>(false);
  const noBlobRef = useRef<boolean>(false);
  const disableRampRef = useRef<boolean>(false);
  const disableWarmupRef = useRef<boolean>(false);
  const memoryOffsetFramesRef = useRef<number>(2);

  // Debug / Diagnostics (toggled by ?debugVideo=1 or localStorage.featuresVideoDebug=1)
  const [debugHud, setDebugHud] = useState(true);
  const debugEnabledRef = useRef(false);
  const lastRvfcMsRef = useRef<number>(0);
  const lastCurrentTimeRef = useRef<number>(0);
  const lastSampleRef = useRef<any>(null);
  const freezeReportedUntilRef = useRef<number>(0);
  const logsRef = useRef<Array<any>>([]);
  const [debugTick, setDebugTick] = useState(0);
  const evtCountsRef = useRef<Record<string, number>>({});
  const lastActionRef = useRef<string>("-");
  const watchdogEnabledRef = useRef<boolean>(true);
  const watchdogTripCountRef = useRef<number>(0);
  const stallTypeRef = useRef<string>('none');
  const lastDecodedRef = useRef<number>(0);
  const lastDecodedChangeMsRef = useRef<number>(Date.now());
  const lastTimeChangeMsRef = useRef<number>(Date.now());
  const lastClockTRef = useRef<number>(0);
  const missingMediaStreakRef = useRef<number>(0);

  // For HEVC on iOS/Safari, bias seeks for engine/memory to be closer to I-frames
  // by moving ~1 frame earlier and adding a tiny jitter to avoid consistently
  // landing on the same presentation boundary.
  const computeSeekForKey = (key: FeatureKey | null, baseTime: number, isIntro: boolean = false): number => {
    try {
      const isIOSSafari = isIOSSafariRef.current;
      const fps = normalized?.fps || 30;
      if (!isIOSSafari) return baseTime;
      if (key !== 'engine' && key !== 'memory') return baseTime;
      const frameSec = 1 / (fps || 30);
      if (key === 'memory') {
        // memory: deterministic offset by N frames earlier + tiny fixed offset, no randomness
        const framesEarlier = Math.max(0, memoryOffsetFramesRef.current || 0);
        const tinyOffset = 0.003; // avoid exact boundary and keep stable
        let t = Math.max(0, baseTime - framesEarlier * frameSec + tinyOffset);
        if (t <= 0.01) t = 0.0;
        return t;
      } else if (key === 'engine') {
        // engine: deterministic 1 frame earlier, no randomness
        let t = Math.max(0, baseTime - 1.0 * frameSec);
        if (t <= 0.01) t = 0.0;
        return t;
      } else {
        return baseTime;
      }
    } catch {
      return baseTime;
    }
  };

  const pushLog = (kind: string, extra?: Record<string, any>) => {
    if (!debugEnabledRef.current) return;
    const entry = { ts: Date.now(), kind, ...(extra || {}) };
    logsRef.current.push(entry);
    if (logsRef.current.length > 400) logsRef.current.splice(0, logsRef.current.length - 400);
    try { /* eslint-disable no-console */ console.log('[features-video]', kind, extra || ''); } catch {}
  };

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const enabled = params.get('debugVideo') === '1' || (typeof localStorage !== 'undefined' && localStorage.getItem('featuresVideoDebug') === '1');
      // Force enable HUD for local debugging regardless of flags
      debugEnabledRef.current = true;
      setDebugHud(true);
      // optional flags
      const noBlob = params.get('noBlob') === '1' || (typeof localStorage !== 'undefined' && localStorage.getItem('featuresVideoNoBlob') === '1');
      const disableRamp = params.get('disableRamp') === '1' || (typeof localStorage !== 'undefined' && localStorage.getItem('featuresVideoDisableRamp') === '1');
      const disableWarmup = params.get('disableWarmup') === '1' || (typeof localStorage !== 'undefined' && localStorage.getItem('featuresVideoDisableWarmup') === '1');
      noBlobRef.current = !!noBlob;
      disableRampRef.current = !!disableRamp;
      disableWarmupRef.current = !!disableWarmup;
      (window as any).featuresVideoDebug = {
        dump: () => ({ lastSample: lastSampleRef.current, logs: logsRef.current.slice(-100) }),
        copy: async () => {
          try {
            const payload = JSON.stringify({ lastSample: lastSampleRef.current, logs: logsRef.current }, null, 2);
            await navigator.clipboard.writeText(payload);
            alert('Copied features video debug logs to clipboard');
          } catch {}
        },
        enableHud: () => setDebugHud(true),
        disableHud: () => setDebugHud(false)
      };
    } catch {}
    // Ramping enabled by default (local testing): ensure not forcibly disabled
    try { disableRampRef.current = false; } catch {}
  }, []);

  // No freeze detection (removed by request)

  // Simple logger
  const log = (label: string, data?: Record<string, any>) => {
    try {
      const payload = data ? ` ${JSON.stringify(data)}` : '';
      // eslint-disable-next-line no-console
      // console.log(`[features-video] ${label}${payload}`);
    } catch {
      // eslint-disable-next-line no-console
      // console.log(`[features-video] ${label}`);
    }
  };

  // Load markers once
  useEffect(() => {
    let aborted = false;
    fetch("/navi-features-markers.json")
      .then(r => r.json())
      .then((data: MarkersFile) => { if (!aborted) {
        setMarkers(data);
        log('markers-loaded', { fps: data.fps, keys: ['customization','conversations','engine','memory','privacy'] });
      } })
      .catch(() => {});
    return () => { aborted = true; };
  }, []);

  // Track video loading state
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const setReady = () => setIsVideoLoading(false);
    const setLoading = () => setIsVideoLoading(true);

    video.addEventListener('loadstart', setLoading);
    video.addEventListener('waiting', setLoading);
    video.addEventListener('stalled', setLoading);
    video.addEventListener('canplay', setReady);
    video.addEventListener('canplaythrough', setReady);
    video.addEventListener('playing', setReady);
    video.addEventListener('loadeddata', setReady);

    return () => {
      video.removeEventListener('loadstart', setLoading);
      video.removeEventListener('waiting', setLoading);
      video.removeEventListener('stalled', setLoading);
      video.removeEventListener('canplay', setReady);
      video.removeEventListener('canplaythrough', setReady);
      video.removeEventListener('playing', setReady);
      video.removeEventListener('loadeddata', setReady);
    };
  }, []);

  // Simple background buffering - no UI, no complexity (can disable via flag)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !markers) return;
    if (disableWarmupRef.current) return;

    const forceBuffering = () => {
      const duration = video.duration || 0;
      if (duration > 0) {
        // Simple: just seek to end and back to force full buffering
        video.currentTime = duration - 0.1;
        setTimeout(() => {
          video.currentTime = 0;
        }, 100);
      }
    };

    const onLoadedMetadata = () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      forceBuffering();
    };

    video.addEventListener('loadedmetadata', onLoadedMetadata);
    if (video.readyState >= 1) forceBuffering();

    return () => video.removeEventListener('loadedmetadata', onLoadedMetadata);
  }, [markers]);

  // Background prefetch full file to Blob and swap to object URL ASAP (page load)
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Decide source we actually want to prefetch (match what the browser would choose)
    const ua = navigator.userAgent.toLowerCase();
    const isSafari = ua.includes('safari') && !ua.includes('chrome') && !ua.includes('firefox');
    const isIOS = /iphone|ipad|ipod/.test(ua);
    const sourceUrl = (isSafari || isIOS) ? MASTER_SRC_HEVC : MASTER_SRC_WEBM;
    isHevcRef.current = (isSafari || isIOS);
    isIOSSafariRef.current = isSafari && isIOS;

    // Always prefetch to Blob; do not rely on public <source> URLs

    let aborted = false;
    (async () => {
      try {
        const res = await fetch(sourceUrl, { cache: 'force-cache', credentials: 'same-origin' });
        if (!res.ok) return;
        const blob = await res.blob();
        if (aborted) return;
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        // Swap src to object URL; use Blob only
        video.src = url;
        video.preload = 'auto';
        try { video.load(); } catch {}
        try { await video.play(); } catch {}
      } catch {}
    })();

    return () => {
      aborted = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  // Handle feature change by setting targetKey; state machine decides the flow
  useEffect(() => {
    const key = mapIndexToKey(activeIndex);
    targetKeyRef.current = key;
    log('feature-requested', { index: activeIndex, key });
  }, [activeIndex]);

  // Per-frame loop: simple state machine per spec + debug sampling
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !normalized) return;

    const onTick = (mediaTime?: number) => {
      const video = videoRef.current;
      if (!video || !normalized) { schedule(); return; }
      const eps = Math.max(0.005, 1 / (normalized.fps || 30) * 0.9);
      const t = typeof mediaTime === 'number' ? mediaTime : video.currentTime;

      // Debug sample via RVFC/RAF
      if (debugEnabledRef.current) {
        const vq = (video as any).getVideoPlaybackQuality?.();
        const decoded = vq?.totalVideoFrames ?? (video as any).webkitDecodedFrameCount;
        const dropped = vq?.droppedVideoFrames ?? (video as any).webkitDroppedFrameCount;
        const ranges: Array<[number, number]> = [];
        try {
          for (let i = 0; i < video.buffered.length; i++) {
            const s = video.buffered.start(i);
            const e = video.buffered.end(i);
            ranges.push([Number(s.toFixed(3)), Number(e.toFixed(3))]);
          }
        } catch {}
        const nowMs = Date.now();
        lastRvfcMsRef.current = nowMs;
        if ((decoded ?? 0) !== (lastDecodedRef.current ?? 0)) {
          lastDecodedChangeMsRef.current = nowMs;
          lastDecodedRef.current = decoded ?? 0;
        }
        if (typeof t === 'number' && Math.abs(t - (lastClockTRef.current ?? 0)) > 0.0005) {
          lastTimeChangeMsRef.current = nowMs;
          lastClockTRef.current = t;
        }
        // Track consecutive missing mediaTime frames
        if (typeof mediaTime === 'number') {
          missingMediaStreakRef.current = 0;
        } else {
          missingMediaStreakRef.current = (missingMediaStreakRef.current || 0) + 1;
        }
        const sample = {
          time: Number(t.toFixed(3)),
          mediaTime: typeof mediaTime === 'number' ? Number(mediaTime.toFixed(3)) : null,
          readyState: video.readyState,
          networkState: (video as any).networkState,
          paused: video.paused,
          seeking: video.seeking,
          rate: video.playbackRate,
          decoded,
          dropped,
          buffered: ranges,
        };
        lastSampleRef.current = sample;
        pushLog('rvfc-sample', sample);
      }

      const where = findContainingFeature(normalized, t);

      // If a new target is requested, decide how to leave current position
      const requested = targetKeyRef.current;
      if (requested) {
        // Special handling: leaving customization uses global time windows to choose a unique outro
        if (where.key === "customization" && requested !== "customization") {
          const cz = normalized.customization;
          // Define global windows and corresponding customization outro markers
          const windows = [
            { name: "anthropic" as const, start: 70, end: 110, mStart: cz.outroAnthropicStart, mEnd: cz.outroAnthropicEnd },
            { name: "meta" as const, start: 150, end: 190, mStart: cz.outroMetaStart, mEnd: cz.outroMetaEnd },
            { name: "deepseak" as const, start: 230, end: 270, mStart: cz.outroDeepseakStart, mEnd: cz.outroDeepseakEnd },
            { name: "gemini" as const, start: 310, end: 350, mStart: cz.outroGeminiStart, mEnd: cz.outroGeminiEnd },
            // oai uses generic outroStart/End
            { name: "oai" as const, start: 390, end: 430, mStart: cz.outroStart, mEnd: cz.outroEnd },
          ];
          // Activate waiting mode until we enter any valid global window
          if (modeRef.current !== "customAwaitWindow" && modeRef.current !== "customOutroPlaying") {
            customPlanRef.current = { windows, targetKey: requested };
            modeRef.current = "customAwaitWindow";
            log('CZ-await-any-window');
          }
        }

        const targetSeg = normalized[requested];
        if (modeRef.current === "idle") {
          if (where.part === "cycle" || where.part === "outro") {
            // P1: ramp to 4x for up to 1s and run until outroEnd
            // Note: playbackRate will remain 1.0 when disableRampRef.current is true
            modeRef.current = "ramping";
            rampStartMsRef.current = performance.now();
            const curSeg = normalized[where.key];
            stopAtRef.current = curSeg.outroEnd;
            log('P1-ramp-start', { fromKey: where.key, fromPart: where.part, stopAt: curSeg.outroEnd.toFixed(3) });
          } else {
            // In intro or none: seek directly to target intro
            modeRef.current = "seeking";
            log('intro->seek-to-target-intro', { fromKey: where.key, fromPart: where.part, targetKey: requested, targetIntro: Number(targetSeg.introStart.toFixed(3)) });
          }
        }
        if (modeRef.current === "ramping") {
          const k = Math.min((performance.now() - rampStartMsRef.current) / 1000, 1);
          const isHevc = isHevcRef.current;
          const maxRate = isHevc ? 2 : 4;
          const desiredRate = 1 + (maxRate - 1) * k;
          // Disable speed-up as soon as we enter the current segment's outro
          const curSeg = normalized[where.key];
          if (t >= curSeg.outroStart - eps) {
            video.playbackRate = 1.0;
          } else {
            video.playbackRate = disableRampRef.current ? 1.0 : desiredRate;
          }
          if (t >= stopAtRef.current - eps) {
            video.playbackRate = 1.0;
            modeRef.current = "seeking";
            log('P1-hit-outroEnd', { at: Number(t.toFixed(3)) });
          }
        }
        // Customization: wait until inside valid global window, then jump to selected outro start
        if (modeRef.current === "customAwaitWindow" && customPlanRef.current) {
          const plan = customPlanRef.current;
          // Keep normal playback (no speed-up) while waiting to reach a valid window
          (video as HTMLVideoElement).playbackRate = 1.0;
          // Windows are defined in FRAMES; convert to seconds using fps
          const fps = normalized.fps || 30;
          const chosen = plan.windows.find(w => t >= (w.start / fps) && t <= (w.end / fps));
          if (chosen) {
            const mStart = chosen.mStart;
            const mEnd = chosen.mEnd;
            if (mStart != null && mEnd != null) {
              plan.chosen = { validStart: chosen.start, validEnd: chosen.end, outroStart: mStart, outroEnd: mEnd };
              // Disable speed-up as soon as we jump into an outro
              (video as HTMLVideoElement).playbackRate = 1.0;
              (video as HTMLVideoElement).currentTime = mStart + 0.001;
              try { (video as HTMLVideoElement).play(); } catch {}
              modeRef.current = "customOutroPlaying";
              log('CZ-seek-outro-start', { window: chosen.name, to: Number(mStart.toFixed(3)) });
            } else {
              log('CZ-missing-markers-fallback');
            }
          }
        }
        // While playing the chosen customization outro, upon reaching its end, proceed to target feature intro
        if (modeRef.current === "customOutroPlaying" && customPlanRef.current) {
          const plan = customPlanRef.current;
          const end = plan.chosen?.outroEnd ?? Number.POSITIVE_INFINITY;
          if (t >= end - eps) {
            // Reuse generic seeking flow to target intro
            modeRef.current = "seeking";
            log('CZ-hit-outroEnd', { at: Number(t.toFixed(3)) });
          }
        }
        if (modeRef.current === "seeking") {
          video.playbackRate = 1.0;
          // Special handling for near-zero intros on HEVC to avoid Safari snapping past intro on seek
          const isNearZero = targetSeg.introStart <= 0.01;
          const isHevc = isHevcRef.current;
          if (isNearZero && isHevc) {
            const onLoaded = () => {
              try { (video as HTMLVideoElement).removeEventListener('loadedmetadata', onLoaded as any); } catch {}
              (video as HTMLVideoElement).currentTime = 0.0;
              try { (video as HTMLVideoElement).play(); } catch {}
              activeKeyRef.current = requested;
              targetKeyRef.current = null;
              modeRef.current = "idle";
              customPlanRef.current = null;
              verifyAfterSeekRef.current = requested;
              seekRetryRef.current = 0;
              log('seek-zero-intro-reload', { key: activeKeyRef.current });
              schedule();
            };
            try { (video as HTMLVideoElement).addEventListener('loadedmetadata', onLoaded as any, { once: true } as any); } catch {}
            try { (video as HTMLVideoElement).load(); } catch {}
          } else {
            // Prefer an exact 0.0 when introStart is very close to 0 to avoid keyframe snap past intro
            const baseDesired = isNearZero ? 0.0 : (targetSeg.introStart + 0.001);
            const desired = computeSeekForKey(requested, baseDesired, true);
            (video as HTMLVideoElement).currentTime = desired;
            try { (video as HTMLVideoElement).play(); } catch {}
            activeKeyRef.current = requested;
            targetKeyRef.current = null;
            modeRef.current = "idle";
            customPlanRef.current = null;
            verifyAfterSeekRef.current = requested;
            seekRetryRef.current = 0;
            log('seek-to-intro', { key: activeKeyRef.current, introStart: Number(targetSeg.introStart.toFixed(3)) });
            schedule();
          }
        }
      }

      // After a seek, verify we actually landed inside the intro; suppress cycle-looping until confirmed
      if (modeRef.current === "idle" && activeKeyRef.current && verifyAfterSeekRef.current === activeKeyRef.current) {
        const seg = normalized[activeKeyRef.current];
        // Not yet inside intro: keep waiting (do not clear verification)
        if (t < seg.introStart - eps) {
          log('intro-waiting', { key: activeKeyRef.current, t: Number(t.toFixed(3)), want: Number(seg.introStart.toFixed(3)) });
          schedule();
          return;
        }
        // Inside intro window
        if (t <= seg.introEnd - eps) {
          log('intro-confirmed', { key: activeKeyRef.current, t: Number(t.toFixed(3)) });
          verifyAfterSeekRef.current = null;
          // Continue into normal flow
        } else {
          // Landed past intro: retry seek once to introStart for all segments
          if (seekRetryRef.current < 1) {
            const baseDesired = seg.introStart <= 0.01 ? 0.0 : (seg.introStart + 0.001);
            const desired = computeSeekForKey(activeKeyRef.current, baseDesired, true);
            (video as HTMLVideoElement).currentTime = desired;
            try { (video as HTMLVideoElement).play(); } catch {}
            seekRetryRef.current += 1;
            log(seg.introStart <= 0.01 ? 'intro-correction-seek0' : 'intro-retry-seek', { key: activeKeyRef.current, to: Number(desired.toFixed(3)) });
            schedule();
            return;
          }
          // Give up after one retry to avoid infinite loop
          log('intro-giveup', { key: activeKeyRef.current, t: Number(t.toFixed(3)) });
          verifyAfterSeekRef.current = null;
        }
      }

      // Loop the active feature's cycle while idle
      // IMPORTANT: skip looping while we are verifying a recent seek, because `t` may still
      // reflect the previous segment's time and incorrectly trigger a cycle loop on the new segment
      if (modeRef.current === "idle" && activeKeyRef.current && !verifyAfterSeekRef.current) {
        const seg = normalized[activeKeyRef.current];
        if (t >= seg.cycleEnd - eps) {
          const desired = computeSeekForKey(activeKeyRef.current, seg.cycleStart + 0.001);
          video.currentTime = desired;
          try { video.play(); } catch {}
          log('P2-loop-cycle', { key: activeKeyRef.current, from: Number(seg.cycleEnd.toFixed(3)), to: Number(seg.cycleStart.toFixed(3)) });
          schedule();
        }
      }
      // Suppress cycle-looping while awaiting/playing customization outro
      if ((modeRef.current === "customAwaitWindow" || modeRef.current === "customOutroPlaying") && activeKeyRef.current) {
        // No-op: loop suppression achieved by not being in 'idle' mode
      }

      schedule();
    };

    const schedule = () => {
      const video = videoRef.current as any;
      if (!video) return;
      if (scheduledRef.current) return;
      const rvfc = typeof video.requestVideoFrameCallback === 'function'
        ? video.requestVideoFrameCallback.bind(video) as (cb: (now: number, meta: any) => void) => number
        : undefined;
      scheduledRef.current = true;
      if (rvfc) {
        vfcIdRef.current = rvfc((now, meta) => {
          scheduledRef.current = false;
          onTick(meta?.mediaTime);
        });
      } else {
        rafRef.current = requestAnimationFrame(() => { scheduledRef.current = false; onTick(); });
      }
    };

    schedule();
    const onTimeUpdate = () => onTick();
    const onSeeked = () => onTick();
    const onEvent = (name: string) => () => {
      if (!debugEnabledRef.current) return;
      try {
        const v = videoRef.current as HTMLVideoElement | null;
        if (!v) return;
        evtCountsRef.current[name] = (evtCountsRef.current[name] || 0) + 1;
        pushLog(`evt:${name}`, {
          t: Number(v.currentTime.toFixed(3)),
          readyState: v.readyState,
          networkState: (v as any).networkState,
          paused: v.paused,
          seeking: v.seeking,
          rate: v.playbackRate
        });
      } catch {}
    };
    const evs = ['loadedmetadata','loadeddata','canplay','canplaythrough','playing','pause','seeking','seeked','stalled','waiting','timeupdate','ratechange','suspend','error'];
    const extraEvs = ['progress','durationchange','emptied','abort'];
    evs.forEach(e => v.addEventListener(e as any, onEvent(e)));
    extraEvs.forEach(e => v.addEventListener(e as any, onEvent(e)));
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('seeked', onSeeked);
    return () => {
      const video = videoRef.current as any;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (vfcIdRef.current && video && typeof video.cancelVideoFrameCallback === 'function') {
        try {
          const cancel = video.cancelVideoFrameCallback.bind(video) as (id: number) => void;
          cancel(vfcIdRef.current as number);
        } catch {}
      }
      scheduledRef.current = false;
      try {
        v.removeEventListener('timeupdate', onTimeUpdate);
        v.removeEventListener('seeked', onSeeked);
        evs.forEach(e => v.removeEventListener(e as any, onEvent(e)));
        extraEvs.forEach(e => v.removeEventListener(e as any, onEvent(e)));
      } catch {}
    };
  }, [normalized]);

  // Freeze detection (debug-only)
  useEffect(() => {
    if (!debugHud) return;
    const id = setInterval(() => {
      if (!debugEnabledRef.current) return;
      const v = videoRef.current;
      if (!v) return;
      const now = Date.now();
      const t = v.currentTime;
      const dtMs = now - lastRvfcMsRef.current;
      const ctStalled = Math.abs(t - lastCurrentTimeRef.current) < 0.001;
      const shouldBePlaying = !v.paused && !v.seeking && v.playbackRate > 0.0;
      // Classify stall type
      const vq = (v as any).getVideoPlaybackQuality?.();
      const decoded = vq?.totalVideoFrames ?? (v as any).webkitDecodedFrameCount;
      const decodedDelta = (decoded ?? 0) - (lastDecodedRef.current ?? 0);
      const sinceDecodedChange = now - (lastDecodedChangeMsRef.current || now);
      const sinceTimeChange = now - (lastTimeChangeMsRef.current || now);
      if (shouldBePlaying) {
        const clockAdvancing = sinceTimeChange < 150; // media clock recently advanced
        if (clockAdvancing && sinceDecodedChange > 150 && !v.seeking && v.readyState >= 2) {
          stallTypeRef.current = 'presentational';
        } else if (dtMs > 150 && v.readyState < 2) {
          stallTypeRef.current = 'buffering';
        } else if (ctStalled) {
          stallTypeRef.current = 'time-stalled';
        } else {
          stallTypeRef.current = 'none';
        }
      } else {
        stallTypeRef.current = 'none';
      }
      if (shouldBePlaying) {
        if ((dtMs > 600 || ctStalled) && now > freezeReportedUntilRef.current) {
          freezeReportedUntilRef.current = now + 2000;
          const dropped = vq?.droppedVideoFrames ?? (v as any).webkitDroppedFrameCount;
          const ranges: Array<[number, number]> = [];
          try {
            for (let i = 0; i < v.buffered.length; i++) {
              const s = v.buffered.start(i);
              const e = v.buffered.end(i);
              ranges.push([Number(s.toFixed(3)), Number(e.toFixed(3))]);
            }
          } catch {}
          pushLog('freeze-suspect', {
            sinceMs: dtMs,
            time: Number(t.toFixed(3)),
            readyState: v.readyState,
            networkState: (v as any).networkState,
            paused: v.paused,
            seeking: v.seeking,
            rate: v.playbackRate,
            decoded,
            dropped,
            buffered: ranges
          });
          if (watchdogEnabledRef.current) {
            // Auto-recover watchdog: try micro-seek, then pause/play, then CSS jiggle
            watchdogTripCountRef.current += 1;
            lastActionRef.current = `watchdog(${stallTypeRef.current}) trip #${watchdogTripCountRef.current}`;
            try {
              v.currentTime = Math.min((v.currentTime || 0) + 0.033, (v.duration || 0) - 0.001);
              v.playbackRate = 1.0;
              v.play().catch(() => {});
              lastActionRef.current += ` | micro-seek @${v.currentTime.toFixed(3)}`;
            } catch {}
            try {
              v.pause();
              setTimeout(() => { try { v.play(); } catch {} }, 60);
              lastActionRef.current += ' | pause/play';
            } catch {}
            try {
              const el = v as any;
              // Force GPU plane rebind without layout: toggle will-change and a tiny scale
              const prevWill = el.style.willChange || '';
              const prevTrans = el.style.transform || '';
              el.style.willChange = 'transform';
              el.style.transform = `${prevTrans} scale(1.0001)`;
              setTimeout(() => {
                try {
                  el.style.transform = prevTrans;
                  el.style.willChange = prevWill;
                } catch {}
              }, 120);
              lastActionRef.current += ' | gpu-rebind';
            } catch {}
          }
        }
      }
      lastCurrentTimeRef.current = t;
    }, 300);
    return () => clearInterval(id);
  }, [debugHud]);

  // Keep HUD values live by ticking state
  useEffect(() => {
    if (!debugHud) return;
    const id = setInterval(() => setDebugTick((n) => (n + 1) % 1000000), 250);
    return () => clearInterval(id);
  }, [debugHud]);

  const bindRef = (el: HTMLVideoElement | null) => { videoRef.current = el; };

  return (
    <div className="w-full h-full relative overflow-hidden rounded-2xl" style={{ overflow: isIOSSafariRef.current ? 'visible' as any : undefined }}>
      <div className="absolute inset-0 origin-center lg:scale-[0.78]" style={{ transformOrigin: 'center center' }}>
        <video
          ref={bindRef}
          className="w-full h-full object-contain"
          style={{ 
            backgroundColor: 'transparent',
            opacity: isVideoLoading ? 0 : 1,
            transition: 'opacity 300ms ease-in-out',
            borderRadius: isIOSSafariRef.current ? 16 : undefined
          }}
          playsInline
          muted
          preload="auto"
          autoPlay
          src={blobUrlRef.current || ''}
        />
        <VideoLoadingAnimation isVisible={isVideoLoading} />
      </div>
    </div>
  );
}

 