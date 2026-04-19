import { useEffect, useState } from 'react';
import type { RefObject } from 'react';

// ---------------------------------------------------------------------------
// Typed-text vertical spacing (1/3 between circle bottom and arrow top)
// ---------------------------------------------------------------------------

/** Keeps the typed text centered in the third of the space below the circle. */
export function useTypedTopSpacing(
  circleRef: RefObject<HTMLDivElement>,
  arrowBtnRef: RefObject<HTMLButtonElement>,
  deps: unknown[],
): number {
  const [typedTopSpacing, setTypedTopSpacing] = useState<number>(24);

  useEffect(() => {
    const measure = () => {
      const circleEl = circleRef.current;
      const arrowEl = arrowBtnRef.current;
      if (!circleEl || !arrowEl) return;
      const distance = arrowEl.getBoundingClientRect().top - circleEl.getBoundingClientRect().bottom;
      if (!isFinite(distance)) return;
      setTypedTopSpacing(Math.max(12, Math.round(distance / 3)));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
    };
    // circleRef / arrowBtnRef are stable refs — safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return typedTopSpacing;
}

// ---------------------------------------------------------------------------
// Arrow visibility (show only while hero is in view)
// ---------------------------------------------------------------------------

/** Observes a section; returns true while it's intersecting the viewport. */
export function useSectionVisible(sectionRef: RefObject<HTMLElement>): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: [0, 0.01] },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return visible;
}

// ---------------------------------------------------------------------------
// Header-height CSS variables (keep gap consistent on mobile/desktop)
// ---------------------------------------------------------------------------

function applyHeroSizing(section: HTMLElement): void {
  const hh = document.getElementById('site-header')?.getBoundingClientRect().height ?? 64;
  const isMobile = window.matchMedia('(max-width: 640px)').matches;
  const topGap = Math.round(isMobile ? hh + 4 : hh + 8);
  section.style.setProperty('--header-h', `${Math.round(hh)}px`);
  section.style.setProperty('--hero-top-gap', `${topGap}px`);
  section.style.setProperty('--hero-svh-base', isMobile ? '65svh' : '75svh');
}

/** Writes header-h / hero-top-gap / hero-svh-base CSS variables on resize. */
export function useHeroSizing(sectionRef: RefObject<HTMLElement>): void {
  useEffect(() => {
    const update = () => {
      if (sectionRef.current) applyHeroSizing(sectionRef.current);
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

// ---------------------------------------------------------------------------
// iOS Safari freeze workaround (reload source on focus/visibility changes)
// ---------------------------------------------------------------------------

function makeSafariVideoHandlers(
  video: HTMLVideoElement,
  shouldBePlaying: boolean,
): {
  onVisibility: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onPageShow: (ev: PageTransitionEvent) => void;
} {
  const playVideo = () => {
    if (video.paused) {
      const currentTime = video.currentTime;
      video.load();
      video.currentTime = currentTime;
      setTimeout(() => {
        video.play().catch(() => {});
      }, 100);
    }
  };
  const pauseVideo = () => {
    if (!video.paused) video.pause();
  };
  return {
    onVisibility: () => {
      if (document.hidden) pauseVideo();
      else if (shouldBePlaying) playVideo();
    },
    onFocus: () => {
      if (shouldBePlaying) playVideo();
    },
    onBlur: pauseVideo,
    onPageShow: (ev) => {
      if (ev.persisted) playVideo();
    },
  };
}

/** Handles Safari/iOS quirks that pause or freeze the hero video. */
export function useSafariVideoLifecycle(
  videoRef: RefObject<HTMLVideoElement>,
  shouldLoadVideo: boolean,
  shouldBePlaying: boolean,
): void {
  useEffect(() => {
    if (!shouldLoadVideo) return;
    const video = videoRef.current;
    if (!video) return;

    const h = makeSafariVideoHandlers(video, shouldBePlaying);
    document.addEventListener('visibilitychange', h.onVisibility);
    window.addEventListener('focus', h.onFocus);
    window.addEventListener('blur', h.onBlur);
    window.addEventListener('pageshow', h.onPageShow);

    return () => {
      document.removeEventListener('visibilitychange', h.onVisibility);
      window.removeEventListener('focus', h.onFocus);
      window.removeEventListener('blur', h.onBlur);
      window.removeEventListener('pageshow', h.onPageShow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldLoadVideo, shouldBePlaying]);
}

// ---------------------------------------------------------------------------
// Play/pause orchestration based on viewport visibility
// ---------------------------------------------------------------------------

/** Returns whether the video should currently be playing given its visibility. */
export function useVideoShouldPlay(
  videoRef: RefObject<HTMLVideoElement>,
  shouldLoadVideo: boolean,
): boolean {
  const [shouldBePlaying, setShouldBePlaying] = useState(true);

  useEffect(() => {
    const node = videoRef.current;
    if (!node) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        setShouldBePlaying(entry.isIntersecting && entry.intersectionRatio > 0);
      },
      { threshold: [0], rootMargin: '0px' },
    );
    io.observe(node);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldLoadVideo]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (shouldBePlaying) video.play().catch(() => {});
    else video.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldBePlaying]);

  return shouldBePlaying;
}
