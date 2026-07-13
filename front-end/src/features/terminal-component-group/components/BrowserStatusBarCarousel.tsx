/**
 * STATE MACHINE: BrowserStatusBarCarousel
 *
 * [SINGLE_BROWSER] <-- browsers.length <= 1
 *     |
 *     v (multiple browsers)
 * [CAROUSEL_MODE] <-- browsers.length > 1
 *     |
 *     +--> activeIndex: 0..N (which browser tab is shown)
 *     +--> navigate via up/down arrows
 *
 * State:
 * - activeIndex: number (current browser index)
 *
 * Auto-adjusts activeIndex when browsers array changes.
 */

import { memo, useState, useCallback, useEffect } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { getQueryParams } from '@/lib/url';
import BrowserStatusBar from './BrowserStatusBar';

interface BrowserSession {
  taskId: string;
  browserUrl: string;
}

interface BrowserStatusBarCarouselProps {
  browsers: BrowserSession[];
}

interface CarouselNavProps {
  activeIndex: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

function CarouselNav({ activeIndex, total, onPrev, onNext }: CarouselNavProps) {
  return (
    <div className="absolute -left-6 sm:-left-12 top-1/2 -translate-y-1/2 flex flex-col items-center gap-1">
      <button
        onClick={onPrev}
        className="p-1.5 rounded-lg border border-border bg-card/50 hover:bg-card/80 transition-colors"
        aria-label="Previous browser"
      >
        <ChevronUp className="h-4 w-4 text-muted-foreground" />
      </button>
      <span className="text-xs text-center text-muted-foreground tabular-nums">
        {activeIndex + 1}/{total}
      </span>
      <button
        onClick={onNext}
        className="p-1.5 rounded-lg border border-border bg-card/50 hover:bg-card/80 transition-colors"
        aria-label="Next browser"
      >
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      </button>
    </div>
  );
}

interface CarouselItemProps {
  browser: BrowserSession;
  idx: number;
  activeIndex: number;
  total: number;
  onSelect: (idx: number) => void;
}

function CarouselItem({ browser, idx, activeIndex, total, onSelect }: CarouselItemProps) {
  let relativePos = idx - activeIndex;
  if (relativePos < 0) {
    relativePos = total + relativePos;
  }
  const isActive = relativePos === 0;

  return (
    <div
      onClick={isActive ? undefined : () => onSelect(idx)}
      className={`transition-all duration-300 ease-out ${
        !isActive ? 'cursor-pointer rounded-xl hover:ring-2 hover:ring-primary/50' : ''
      }`}
      style={{
        position: isActive ? 'relative' : 'absolute',
        top: 0,
        left: 0,
        right: 0,
        transform: `translate(${relativePos * 16}px, ${-relativePos * 16}px)`,
        zIndex: 40 - relativePos,
      }}
    >
      <BrowserStatusBar
        taskId={browser.taskId}
        browserUrl={browser.browserUrl}
        forceMinimized={!isActive}
      />
    </div>
  );
}

function BrowserStatusBarCarouselImpl({ browsers }: BrowserStatusBarCarouselProps) {
  const [activeIndex, setActiveIndex] = useState(() => findInitialBrowserIndex(browsers));
  const hasMultipleBrowsers = browsers.length > 1;

  useEffect(() => {
    if (activeIndex >= browsers.length) {
      setActiveIndex(Math.max(0, browsers.length - 1));
    }
  }, [browsers.length, activeIndex]);

  useEffect(() => {
    const browserId = getQueryParams().get('browser-id');
    if (!browserId) return;
    const idx = browsers.findIndex((browser) => browser.taskId === browserId);
    if (idx >= 0) setActiveIndex(idx);
  }, [browsers]);

  useEffect(() => {
    const handleOpenBrowser = (event: Event) => {
      const taskId = (event as CustomEvent<{ taskId?: string }>).detail?.taskId;
      if (!taskId) return;
      const idx = browsers.findIndex((browser) => browser.taskId === taskId);
      if (idx >= 0) setActiveIndex(idx);
    };

    window.addEventListener('navi-open-browser', handleOpenBrowser);
    return () => window.removeEventListener('navi-open-browser', handleOpenBrowser);
  }, [browsers]);

  const handlePrevBrowser = useCallback(() => {
    setActiveIndex((prev) => (prev - 1 + browsers.length) % browsers.length);
  }, [browsers.length]);

  const handleNextBrowser = useCallback(() => {
    setActiveIndex((prev) => (prev + 1) % browsers.length);
  }, [browsers.length]);

  if (browsers.length === 0) return null;

  if (!hasMultipleBrowsers) {
    const browser = browsers[0];
    return (
      <div className="w-full max-w-4xl mx-auto mb-3 relative z-30">
        <BrowserStatusBar taskId={browser.taskId} browserUrl={browser.browserUrl} />
      </div>
    );
  }

  return (
    <div className="w-full max-w-4xl mx-auto mb-3 relative z-30">
      <CarouselNav
        activeIndex={activeIndex}
        total={browsers.length}
        onPrev={handlePrevBrowser}
        onNext={handleNextBrowser}
      />
      <div className="relative">
        {browsers.map((browser, idx) => (
          <CarouselItem
            key={browser.taskId}
            browser={browser}
            idx={idx}
            activeIndex={activeIndex}
            total={browsers.length}
            onSelect={setActiveIndex}
          />
        ))}
      </div>
    </div>
  );
}

const BrowserStatusBarCarousel = memo(BrowserStatusBarCarouselImpl);
export default BrowserStatusBarCarousel;

function findInitialBrowserIndex(browsers: BrowserSession[]): number {
  if (typeof window === 'undefined') return 0;
  const browserId = getQueryParams().get('browser-id');
  if (!browserId) return 0;
  const idx = browsers.findIndex((browser) => browser.taskId === browserId);
  return idx >= 0 ? idx : 0;
}
