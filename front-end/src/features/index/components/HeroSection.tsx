/**
 * STATE MACHINE: HeroSection
 *
 * TYPEWRITER EFFECT:
 * [TYPING] --> typedText grows character by character
 *   |
 *   v (text complete)
 * [TYPED_COMPLETE]
 *
 * VIDEO LOADING:
 * [VIDEO_NOT_LOADED] --> shouldLoadVideo: false
 *   |
 *   v (scroll/timeout triggers)
 * [VIDEO_LOADING] --> shouldLoadVideo: true, isVideoReady: false
 *   |
 *   v (video can play)
 * [VIDEO_READY] --> isVideoReady: true
 *   |
 *   v (first frame painted)
 * [VIDEO_PLAYING] --> hasPaintedFirstFrame: true
 *
 * States:
 * - typedText: string (typewriter text content)
 * - shouldLoadVideo: boolean
 * - isVideoReady: boolean
 * - hasPaintedFirstFrame: boolean
 * - shouldBePlaying: boolean (play/pause control)
 * - arrowVisible: boolean (bounce arrow visibility)
 */

import ProgressiveImage from './ProgressiveImage';
import VideoPlayer from './VideoPlayer';
import { useState, useRef } from 'react';
import type { CSSProperties } from 'react';
import { ChevronDown } from 'lucide-react';

import { useTypewriter } from '../hooks';
import {
  useHeroSizing,
  useSafariVideoLifecycle,
  useSectionVisible,
  useTypedTopSpacing,
  useVideoShouldPlay,
} from '../hooks/heroSectionHooks';
import { useDeferredVideoLoad } from '../hooks/videoPlayerHooks';

// Custom CSS variables require widening CSSProperties via an index signature.
type CSSVars = CSSProperties & Record<`--${string}`, string>;

const heroCircleStyle: CSSVars = {
  '--hero-video-size':
    'clamp(300px, min(68vw, calc(var(--hero-svh-base, 75svh) - var(--hero-top-gap, 64px))), 480px)',
  '--hero-circle-size': 'calc(var(--hero-video-size) * var(--hero-circle-scale, 1.25))',
  width: 'var(--hero-circle-size)',
  height: 'var(--hero-circle-size)',
  marginTop: 'clamp(8px, 3vh, 24px)',
};

// ---------------------------------------------------------------------------
// Typed-text speech bubble
// ---------------------------------------------------------------------------

const TypedBubble = ({ typedText, topSpacing }: { typedText: string; topSpacing: number }) => (
  <div
    className="max-w-2xl mx-auto mb-12 reveal-up reveal-delay-1 flex justify-center"
    style={{ marginTop: `${topSpacing}px` }}
  >
    <div className="relative z-40 backdrop-blur-none bg-gradient-to-br from-[#272725] to-[#1f1f1d] border border-border/30 rounded-full p-4 shadow-lg w-[420px]">
      <div className="flex items-center gap-3">
        <div className="flex-shrink-0 mt-1">
          <div className="w-8 h-8 bg-white rounded-full flex items-center justify-center relative">
            <div className="flex items-center gap-0.5">
              <div className="w-0.5 bg-primary rounded-full animate-[voice-bar-1_1.5s_ease-in-out_infinite]"></div>
              <div className="w-0.5 bg-primary rounded-full animate-[voice-bar-2_1.3s_ease-in-out_infinite]"></div>
              <div className="w-0.5 bg-primary rounded-full animate-[voice-bar-3_1.7s_ease-in-out_infinite]"></div>
              <div className="w-0.5 bg-primary rounded-full animate-[voice-bar-4_1.4s_ease-in-out_infinite]"></div>
            </div>
          </div>
        </div>
        <div className="flex-1 min-h-[2rem] flex items-center">
          <p className="hero-typed-text text-base md:text-xl text-white leading-relaxed text-left drop-shadow-sm">
            <span className="inline">
              {typedText}
              <span className="animate-pulse">|</span>
            </span>
          </p>
        </div>
      </div>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Scroll-down arrow
// ---------------------------------------------------------------------------

interface ScrollArrowProps {
  visible: boolean;
  buttonRef: React.RefObject<HTMLButtonElement>;
}

const ScrollArrow = ({ visible, buttonRef }: ScrollArrowProps) => (
  <div
    className={`absolute left-1/2 transform -translate-x-1/2 z-30 transition-opacity duration-200 ${
      visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
    }`}
    style={{ bottom: 'clamp(2px, calc(env(safe-area-inset-bottom, 0px) + 2px), 12px)' }}
  >
    <button
      className="p-3 rounded-full bg-gradient-to-br from-[#272725] to-[#1f1f1d] border border-border/30 hover:bg-gradient-to-br hover:from-[#323230] hover:to-[#252523] transition-all duration-300 shadow-lg animate-slow-bounce"
      onClick={() => document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })}
      aria-label="Scroll to features"
      ref={buttonRef}
    >
      <ChevronDown className="w-6 h-6 text-white" />
    </button>
  </div>
);

// ---------------------------------------------------------------------------
// Main hero
// ---------------------------------------------------------------------------

const HeroSection = () => {
  const typedText = useTypewriter();
  const [hasPaintedFirstFrame, setHasPaintedFirstFrame] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const circleRef = useRef<HTMLDivElement>(null);
  const arrowBtnRef = useRef<HTMLButtonElement>(null);

  const shouldLoadVideo = useDeferredVideoLoad(false);
  const arrowVisible = useSectionVisible(sectionRef);
  const typedTopSpacing = useTypedTopSpacing(circleRef, arrowBtnRef, [hasPaintedFirstFrame]);
  useHeroSizing(sectionRef);
  const shouldBePlaying = useVideoShouldPlay(videoRef, shouldLoadVideo);
  useSafariVideoLifecycle(videoRef, shouldLoadVideo, shouldBePlaying);

  return (
    <section
      ref={sectionRef}
      className="relative z-10 flex flex-col items-center overflow-visible bg-background"
      style={{
        height: '100svh',
        paddingTop: 'var(--hero-top-gap, calc(var(--header-h, 64px) + 8px))',
      }}
    >
      <div className="absolute inset-0 pointer-events-none z-20">
        <div className="absolute inset-0 grid-background"></div>
      </div>

      <div className="container mx-auto px-6 relative z-30 overflow-visible">
        <div className="max-w-4xl xl:max-w-6xl 2xl:max-w-7xl mx-auto text-center overflow-visible">
          <div className="mb-8 md:mt-3 reveal-up flex justify-center">
            <div
              ref={circleRef}
              className="rounded-full p-2 bg-background flex items-center justify-center [--hero-circle-scale:1.15] sm:[--hero-circle-scale:1.2] lg:[--hero-circle-scale:1.125]"
              style={heroCircleStyle}
            >
              <div
                className="rounded-full flex items-center justify-center relative"
                style={{ width: 'var(--hero-video-size)', height: 'var(--hero-video-size)' }}
              >
                <ProgressiveImage
                  lowSrc="/navi-hero-image-low.png"
                  medSrc="/navi-hero-image-med.png"
                  highSrc="/navi-hero-image.png"
                  alt="Rose"
                  className="absolute inset-0 w-full h-full object-cover transform-gpu scale-[1.12] transition-opacity duration-150"
                  style={{ objectPosition: 'center center', opacity: hasPaintedFirstFrame ? 0 : 1 }}
                  fetchPriority="high"
                />
                <VideoPlayer
                  ref={videoRef}
                  src="/navi-hero-animation.webm"
                  className="absolute inset-0 z-10 w-full h-full object-cover transform-gpu scale-[1.12]"
                  style={{
                    objectPosition: 'center center',
                    visibility: hasPaintedFirstFrame ? 'visible' : 'hidden',
                    backgroundColor: 'transparent',
                  }}
                  objectFit="cover"
                  autoPlay={shouldBePlaying}
                  loop
                  muted
                  preload="auto"
                  poster="/navi-midnight-black-hero-background-low.png"
                  onFirstFrame={() => setHasPaintedFirstFrame(true)}
                />
              </div>
            </div>
          </div>

          <TypedBubble typedText={typedText} topSpacing={typedTopSpacing} />
        </div>
      </div>

      <ScrollArrow visible={arrowVisible} buttonRef={arrowBtnRef} />

      {/* Opaque base fill to mask grid between hero and ticker */}
      <div className="absolute bottom-0 left-0 right-0 h-48 bg-background z-0 pointer-events-none"></div>

      {/* Gradient overlay for depth */}
      <div className="absolute bottom-0 left-0 right-0 h-48 bg-gradient-to-t from-background/100 to-transparent pointer-events-none z-10"></div>
    </section>
  );
};

export default HeroSection;
