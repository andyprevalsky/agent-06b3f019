/**
 * STATE MACHINE: PreOrderSection
 *
 * VIDEO LAZY LOADING (per video: black/white):
 * [NOT_IN_VIEW] --> inView: false
 *   |
 *   | (IntersectionObserver triggers)
 *   v
 * [IN_VIEW] --> inView: true (video loads)
 *
 * VIDEO PLAYBACK (per video):
 * [PAUSED] --> visible: false
 *   |
 *   v (visibility enters threshold)
 * [PLAYING] --> visible: true
 *   |
 *   v (visibility exits)
 * [PAUSED]
 *
 * States:
 * - isSafari: boolean (browser detection)
 * - lazyLoadInView: boolean (source attachment gate, latched)
 * - playbackInView: boolean (play/pause gate)
 */

import { useRef } from 'react';

import ColorSwatches from './pre-order-section/ColorSwatches';
import PreOrderCard from './pre-order-section/PreOrderCard';
import { useCardInViewRefs } from './pre-order-section/useCardInViewRefs';
import { useIOSSafariRecovery } from './pre-order-section/useIOSSafariRecovery';
import { useSafariDetection } from './pre-order-section/useSafariDetection';
import { useVideoSync } from './pre-order-section/useVideoSync';
import { useVideoVisibilityPlayback } from './pre-order-section/useVideoVisibilityPlayback';
import { usePreOrder } from '../hooks';

const BLACK_VIDEO_SRC = '/navi-black-v4-white-background.webm';
const BLACK_POSTER_SRC = '/navi-midnight-black-white-background.png';
const WHITE_VIDEO_SRC = '/navi-white-v4-white-background.webm';
const WHITE_POSTER_SRC = '/navi-pearl-white-white-background.png';

const PreOrderSection = () => {
  const blackVideoRef = useRef<HTMLVideoElement>(null);
  const whiteVideoRef = useRef<HTMLVideoElement>(null);

  const isSafari = useSafariDetection();
  const handlePreOrder = usePreOrder();

  const black = useCardInViewRefs();
  const white = useCardInViewRefs();

  useVideoSync({
    isSafari,
    blackVideoRef,
    whiteVideoRef,
    blackInView: black.lazyLoadInView,
    whiteInView: white.lazyLoadInView,
  });
  useVideoVisibilityPlayback(blackVideoRef, black.playbackInView);
  useVideoVisibilityPlayback(whiteVideoRef, white.playbackInView);
  useIOSSafariRecovery(blackVideoRef, whiteVideoRef);

  return (
    <section
      id="pre-order"
      className="relative z-20 py-32 bg-gradient-to-b from-surface to-background overflow-hidden"
    >
      <div className="container mx-auto px-6">
        <div className="text-center mb-16">
          <h2 className="text-5xl font-light tracking-tight mb-6 reveal-up">
            <span className="gradient-text">Pre-order</span>
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto reveal-up reveal-delay-1">
            You've been given early access to acquire one of the first 10 Navis. Choose your
            preferred finish and lock in your spot before the public release.
          </p>

          <ColorSwatches />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
          <PreOrderCard
            title="Midnight Black"
            description="Deep, sophisticated finish with precision-crafted aluminum"
            videoSrc={BLACK_VIDEO_SRC}
            posterSrc={BLACK_POSTER_SRC}
            altText="Navi Black"
            cardClassName="bg-card border-border/50 hover:border-primary/30"
            buttonClassName="btn-luxury"
            cardRevealDelay="reveal-delay-1"
            wrapperRef={black.wrapperRef}
            videoRef={blackVideoRef}
            inView={black.lazyLoadInView}
            onPreOrder={() => handlePreOrder('black')}
          />

          <PreOrderCard
            title="Pearl White"
            description="Lustrous ceramic-like finish that captures and reflects light"
            videoSrc={WHITE_VIDEO_SRC}
            posterSrc={WHITE_POSTER_SRC}
            altText="Navi White"
            cardClassName="bg-surface-elevated border-border/50 hover:border-space-gray/30"
            buttonClassName="btn-pearl"
            cardRevealDelay="reveal-delay-2"
            wrapperRef={white.wrapperRef}
            videoRef={whiteVideoRef}
            inView={white.lazyLoadInView}
            onPreOrder={() => handlePreOrder('white')}
          />
        </div>

        <div className="text-center mt-12 reveal-up reveal-delay-3">
          <p className="text-sm text-muted-foreground mb-4">
            Expected delivery: Q3 2025 • Limited quantities available
          </p>
        </div>
      </div>
    </section>
  );
};

export default PreOrderSection;
