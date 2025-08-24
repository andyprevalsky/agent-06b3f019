import { useEffect, useMemo, useRef, useState } from "react";

type FeatureKey = "customization" | "conversations" | "engine" | "memory" | "privacy";

interface Segment {
  introStart: number;
  introEnd: number;
  cycleStart: number;
  cycleEnd: number;
  outroStart: number;
  outroEnd: number;
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
    if (t >= s.cycleStart && t < s.cycleEnd) return { key, part: "cycle" };
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
    const fix = (s: Segment): Segment => {
      const introStart = Math.max(0, s.introStart);
      const introEnd = Math.max(introStart, s.introEnd);
      const cycleStart = Math.max(introEnd, s.cycleStart);
      const cycleEnd = Math.max(cycleStart + 0.001, s.cycleEnd);
      const outroStart = Math.max(cycleEnd, s.outroStart);
      const outroEnd = Math.max(outroStart + 0.001, s.outroEnd);
      return { introStart, introEnd, cycleStart, cycleEnd, outroStart, outroEnd };
    };
    return {
      fps: markers.fps,
      customization: fix(markers.customization),
      conversations: fix(markers.conversations),
      engine: fix(markers.engine),
      memory: fix(markers.memory),
      privacy: fix(markers.privacy)
    };
  }, [markers]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeKeyRef = useRef<FeatureKey | null>(null);
  const rafRef = useRef<number | null>(null);
  const vfcIdRef = useRef<number | null>(null);
  const scheduledRef = useRef<boolean>(false);
  const modeRef = useRef<"idle" | "ramping" | "awaitOutro" | "seeking">("idle");
  const rampStartMsRef = useRef<number>(0);
  const stopAtRef = useRef<number>(0);
  const targetKeyRef = useRef<FeatureKey | null>(null);
  const verifyAfterSeekRef = useRef<FeatureKey | null>(null);
  const seekRetryRef = useRef<number>(0);

  // Simple logger
  const log = (label: string, data?: Record<string, any>) => {
    try {
      const payload = data ? ` ${JSON.stringify(data)}` : '';
      // eslint-disable-next-line no-console
      console.log(`[features-video] ${label}${payload}`);
    } catch {
      // eslint-disable-next-line no-console
      console.log(`[features-video] ${label}`);
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
          const rate = 1 + (4 - 1) * k;
          video.playbackRate = rate;
          if (t >= stopAtRef.current - eps) {
            video.playbackRate = 1.0;
            modeRef.current = "seeking";
            log('P1-hit-outroEnd', { at: Number(t.toFixed(3)) });
          }
        }
        if (modeRef.current === "seeking") {
          video.playbackRate = 1.0;
          // Special handling for near-zero intros on HEVC to avoid Safari snapping past intro on seek
          const isNearZero = targetSeg.introStart <= 0.01;
          const isHevc = typeof (video as HTMLVideoElement).currentSrc === 'string' && (video as HTMLVideoElement).currentSrc.includes('navi-features-hevc');
          if (isNearZero && isHevc) {
            const onLoaded = () => {
              try { (video as HTMLVideoElement).removeEventListener('loadedmetadata', onLoaded as any); } catch {}
              (video as HTMLVideoElement).currentTime = 0.0;
              try { (video as HTMLVideoElement).play(); } catch {}
              activeKeyRef.current = requested;
              targetKeyRef.current = null;
              modeRef.current = "idle";
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
        vfcIdRef.current = rvfc((now, meta) => { scheduledRef.current = false; onTick(meta?.mediaTime); });
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

  const bindRef = (el: HTMLVideoElement | null) => { videoRef.current = el; };

  return (
    <div className="w-full h-full relative overflow-hidden rounded-2xl">
      <div className="absolute inset-0" style={{ transform: 'scale(0.6667)', transformOrigin: 'center center' }}>
        <video
          ref={bindRef}
          className="w-full h-full object-cover"
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

 