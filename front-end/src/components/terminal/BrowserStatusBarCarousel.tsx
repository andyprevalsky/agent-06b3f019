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
import BrowserStatusBar from './BrowserStatusBar';

interface BrowserSession {
  taskId: string;
  browserUrl: string;
}

interface BrowserStatusBarCarouselProps {
  browsers: BrowserSession[];
}

function BrowserStatusBarCarouselImpl({ browsers }: BrowserStatusBarCarouselProps) {
  const [activeIndex, setActiveIndex] = useState(0);

  const hasMultipleBrowsers = browsers.length > 1;

  // Keep activeIndex in bounds when browsers array changes
  useEffect(() => {
    if (activeIndex >= browsers.length) {
      setActiveIndex(Math.max(0, browsers.length - 1));
    }
  }, [browsers.length, activeIndex]);

  // Navigation handlers
  const handlePrevBrowser = useCallback(() => {
    setActiveIndex((prev) => (prev - 1 + browsers.length) % browsers.length);
  }, [browsers.length]);

  const handleNextBrowser = useCallback(() => {
    setActiveIndex((prev) => (prev + 1) % browsers.length);
  }, [browsers.length]);

  if (browsers.length === 0) return null;

  // Single browser - no carousel needed
  if (!hasMultipleBrowsers) {
    const browser = browsers[0];
    return (
      <div className="w-full max-w-4xl mx-auto mb-3 relative z-30">
        <BrowserStatusBar taskId={browser.taskId} browserUrl={browser.browserUrl} />
      </div>
    );
  }

  // Multiple browsers - render ALL with same component, just change transform/z-index
  return (
    <div className="w-full max-w-4xl mx-auto mb-3 relative z-30">
      {/* Navigation arrows */}
      <div className="absolute -left-12 top-1/2 -translate-y-1/2 flex flex-col items-center gap-1">
        <button
          onClick={handlePrevBrowser}
          className="p-1.5 rounded-lg border border-border bg-card/50 hover:bg-card/80 transition-colors"
          aria-label="Previous browser"
        >
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        </button>
        <span className="text-xs text-center text-muted-foreground tabular-nums">
          {activeIndex + 1}/{browsers.length}
        </span>
        <button
          onClick={handleNextBrowser}
          className="p-1.5 rounded-lg border border-border bg-card/50 hover:bg-card/80 transition-colors"
          aria-label="Next browser"
        >
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      {/* All browsers rendered identically, just positioned differently */}
      <div className="relative">
        {browsers.map((browser, idx) => {
          // Calculate position relative to active
          let relativePos = idx - activeIndex;
          if (relativePos < 0) {
            relativePos = browsers.length + relativePos;
          }

          const isActive = relativePos === 0;

          return (
            <div
              key={browser.taskId}
              onClick={isActive ? undefined : () => setActiveIndex(idx)}
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
        })}
      </div>
    </div>
  );
}

const BrowserStatusBarCarousel = memo(BrowserStatusBarCarouselImpl);
export default BrowserStatusBarCarousel;
