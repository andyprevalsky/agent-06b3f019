import { type CSSProperties, type MutableRefObject } from 'react';

import FeatureVideoStage from '../FeatureVideoStage';

import FeatureMobileCard from './FeatureMobileCard';
import { HERO_BLACK } from '../../config';
import type { FeatureItem } from '../../types';
import { navigateToWaitlistOrPreOrder } from './waitlistNavigation';

interface FeaturesMobileLayoutProps {
  features: FeatureItem[];
  activeFeature: number;
  earlyAccess: boolean;
  isShortHeight: boolean;
  textScales: number[];
  textContainerRefs: MutableRefObject<Array<HTMLDivElement | null>>;
  textContentRefs: MutableRefObject<Array<HTMLUListElement | null>>;
  onScrollToFeature: (index: number) => void;
}

// A real CSS custom property — not a typed DOM field — so cast once here
// with a constrained alias instead of sprinkling `any` inline styles.
type CustomCSSProperties = CSSProperties & Record<`--${string}`, string | number>;

const STICKY_VARS: CustomCSSProperties = { '--features-sticky-top': '96px' };

const MEDIA_BOX_STYLE: CSSProperties = {
  width: 'min(420px, calc(100vw - 24px))',
  height:
    'clamp(240px, calc((100vh - var(--features-sticky-top, 96px) - 72px) * 0.5), 380px)',
};

/**
 * Mobile/tablet layout: sticky video + absolute-positioned cards that
 * fade between each feature, dots pagination, and full-height sentinels
 * for the scroll spy.
 */
export default function FeaturesMobileLayout({
  features,
  activeFeature,
  earlyAccess,
  isShortHeight,
  textScales,
  textContainerRefs,
  textContentRefs,
  onScrollToFeature,
}: FeaturesMobileLayoutProps) {
  const handleNextFeature = () => {
    if (activeFeature >= features.length - 1) {
      navigateToWaitlistOrPreOrder(earlyAccess);
    } else {
      onScrollToFeature(activeFeature + 1);
    }
  };

  return (
    <div className="lg:hidden min-h-[600vh] relative">
      <div
        className="sticky top-24 z-20 flex flex-col items-center space-y-6"
        style={STICKY_VARS}
      >
        <div className="flex items-center justify-center relative" style={MEDIA_BOX_STYLE}>
          <div className="w-full h-full rounded-2xl overflow-hidden bg-transparent relative">
            <FeatureVideoStage activeIndex={activeFeature} />
          </div>
        </div>

        <div className="relative" style={MEDIA_BOX_STYLE}>
          {features.map((feature, index) => (
            <FeatureMobileCard
              key={feature.title}
              feature={feature}
              index={index}
              isActive={activeFeature === index}
              isShortHeight={isShortHeight}
              textScale={textScales[index] ?? 1}
              containerRefs={textContainerRefs}
              contentRefs={textContentRefs}
              onNextFeature={handleNextFeature}
            />
          ))}
        </div>

        <div
          className="flex items-center justify-center gap-2"
          style={{ width: 'min(380px, calc(100vw - 48px))' }}
        >
          {features.map((_, i) => {
            const isActive = activeFeature === i;
            return (
              <button
                key={`dot-m-${i}`}
                aria-label={`Go to feature ${i + 1}`}
                onClick={() => onScrollToFeature(i)}
                className={`h-1.5 transition-all duration-300 ${
                  isActive ? 'w-6 rounded-md' : 'w-1.5 rounded-full'
                }`}
                style={{ backgroundColor: isActive ? HERO_BLACK : '#d1d5db' }}
              />
            );
          })}
        </div>
      </div>

      <div className="lg:hidden block">
        {features.map((_, i) => (
          <div
            key={`mobile-sentinel-${i}`}
            data-sentinel-index={i}
            id={`feature-sentinel-${i}`}
            className="h-[180vh]"
            aria-hidden="true"
          />
        ))}
      </div>
    </div>
  );
}
