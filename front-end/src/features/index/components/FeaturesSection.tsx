/**
 * STATE MACHINE: FeaturesSection
 *
 * ACTIVE FEATURE TRACKING:
 * [FEATURE_0] <-> [FEATURE_1] <-> [FEATURE_2] <-> [FEATURE_3] <-> [FEATURE_4]
 *        ^                                                              |
 *        └──────────────── scroll or click navigation ──────────────────┘
 *
 * States:
 * - activeFeature: 0-4 (which feature is highlighted)
 * - featuresClipPath: CSS clip-path for reveal animation
 * - gridOffsetX: horizontal offset for grid alignment
 * - isShortHeight: responsive state for short viewports
 *
 * Scroll-driven: IntersectionObserver updates activeFeature based on scroll position
 * Click-driven: pauseScrollSpy temporarily disables scroll updates
 */

import { useMemo, useRef } from 'react';

import FeaturesDesktopLayout from './features-section/FeaturesDesktopLayout';
import FeaturesMobileLayout from './features-section/FeaturesMobileLayout';
import { resolveFeatures } from './features-section/resolveFeatures';
import { scrollToFeature as scrollSectionToFeature } from './features-section/scrollToFeature';
import { useFeatureScrollSpy } from './features-section/useFeatureScrollSpy';
import { useGridScrollEffect } from './features-section/useGridScrollEffect';
import { useTextAutoFit } from './features-section/useTextAutoFit';
import { useEarlyAccess, useMediaQuery } from '../hooks';

const SCROLL_SPY_PAUSE_MS = 300;

const FeaturesSection = () => {
  const sectionRef = useRef<HTMLDivElement>(null);
  const earlyAccess = useEarlyAccess();
  const isShortHeight = useMediaQuery('(max-height: 750px)');

  const features = useMemo(() => resolveFeatures(), []);
  const { activeFeature, setActiveFeature, pauseScrollSpy } = useFeatureScrollSpy(sectionRef);
  const { featuresClipPath, gridOffsetX } = useGridScrollEffect(sectionRef);
  const { textContainerRefs, textContentRefs, textScales } = useTextAutoFit(
    activeFeature,
    features.length,
  );

  const handleFeatureClick = (index: number) => {
    setActiveFeature(index);
    pauseScrollSpy(SCROLL_SPY_PAUSE_MS);
    const sentinel = sectionRef.current?.querySelector(
      `[data-sentinel-index="${index}"]`,
    ) as HTMLElement | null;
    sentinel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleScrollToFeature = (index: number) =>
    scrollSectionToFeature(sectionRef.current, index);

  return (
    <section id="features" className="py-24 bg-background relative" ref={sectionRef}>
      <div className="container mx-auto px-6">
        <div className="relative z-10 text-center mb-16">
          <h2 className="text-5xl font-light tracking-tight mb-6 reveal-up">
            <span className="gradient-text">Features</span>
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto reveal-up reveal-delay-1">
            Rose is a hackable smart speaker designed for developers
          </p>
        </div>

        <div
          className="grid-3d-background"
          style={{ clipPath: featuresClipPath, willChange: 'clip-path, background-position' }}
        >
          <div
            className="grid-3d-wall"
            style={{ backgroundPosition: `${-gridOffsetX}px 0px` }}
          ></div>
          <div
            className="grid-3d-floor"
            style={{ backgroundPosition: `${-gridOffsetX}px 0px` }}
          ></div>
        </div>
        <div className="pointer-events-none absolute top-0 left-0 right-0 h-24 z-20 bg-gradient-to-b from-background to-transparent"></div>
        <div className="pointer-events-none absolute -bottom-24 left-0 right-0 h-24 z-0 bg-gradient-to-t from-background to-transparent"></div>

        <FeaturesDesktopLayout
          features={features}
          activeFeature={activeFeature}
          earlyAccess={earlyAccess}
          onFeatureClick={handleFeatureClick}
        />

        <FeaturesMobileLayout
          features={features}
          activeFeature={activeFeature}
          earlyAccess={earlyAccess}
          isShortHeight={isShortHeight}
          textScales={textScales}
          textContainerRefs={textContainerRefs}
          textContentRefs={textContentRefs}
          onScrollToFeature={handleScrollToFeature}
        />
      </div>
    </section>
  );
};

export default FeaturesSection;
