import { useEffect, useMemo, useRef, useState } from "react";

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

  // Simple background buffering - no UI, no complexity
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !markers) return;

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

    let aborted = false;
    (async () => {
      try {
        const res = await fetch(sourceUrl, { cache: 'force-cache', credentials: 'same-origin' });
        if (!res.ok) return;
        const blob = await res.blob();
        if (aborted) return;
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        // Swap src to object URL; this makes all seeks local and seamless
        video.src = url;
        video.preload = 'auto';
        try { video.load(); } catch {}
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

  // Per-frame loop: simple state machine per spec
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !normalized) return;

    const onTick = (mediaTime?: number) => {
      const video = videoRef.current;
      if (!video || !normalized) { schedule(); return; }
      const eps = Math.max(0.005, 1 / (normalized.fps || 30) * 0.9);
      const t = typeof mediaTime === 'number' ? mediaTime : video.currentTime;

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
            video.playbackRate = desiredRate;
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
            const desired = isNearZero ? 0.0 : (targetSeg.introStart + 0.001);
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
            const desired = seg.introStart <= 0.01 ? 0.0 : (seg.introStart + 0.001);
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
          video.currentTime = seg.cycleStart + 0.001;
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
      } catch {}
    };
  }, [normalized]);

  // Freeze detection removed (by request)

  const bindRef = (el: HTMLVideoElement | null) => { videoRef.current = el; };

  return (
    <div className="w-full h-full relative overflow-hidden rounded-2xl">
      <div className="absolute inset-0 transform scale-[1] origin-center md:scale-[1] lg:scale-[0.78] scale-100" style={{ transformOrigin: 'center center' }}>
        <video
          ref={bindRef}
          className="w-full h-full object-contain"
          style={{ backgroundColor: 'transparent' }}
          playsInline
          muted
          preload="auto"
          autoPlay
        >
          <source src={MASTER_SRC_HEVC} type='video/mp4; codecs="hvc1"' />
          <source src={MASTER_SRC_WEBM} type='video/webm; codecs="vp9"' />
        </video>
      </div>
    </div>
  );
}

 