import { type MutableRefObject } from 'react';

import { useIsMobile } from '@/hooks/use-mobile';

import FeatureMobileCardBody from './FeatureMobileCardBody';
import type { FeatureItem } from '../../types';

interface FeatureMobileCardProps {
  feature: FeatureItem;
  index: number;
  isActive: boolean;
  isShortHeight: boolean;
  textScale: number;
  containerRefs: MutableRefObject<Array<HTMLDivElement | null>>;
  contentRefs: MutableRefObject<Array<HTMLUListElement | null>>;
  onNextFeature: () => void;
}

function selectMobileDetails(
  feature: FeatureItem,
  index: number,
  isMobile: boolean,
  isShortHeight: boolean,
): FeatureItem['details'] {
  if (!isMobile) return feature.details;
  if (index === 2) return feature.details.slice(0, 2);
  if (isShortHeight) return feature.details.slice(0, 2);
  return feature.details.slice(0, 3);
}

/**
 * One mobile card (rendered absolute-positioned; fades in when active).
 * Also hosts the per-card "next" bounce arrow.
 */
export default function FeatureMobileCard({
  feature,
  index,
  isActive,
  isShortHeight,
  textScale,
  containerRefs,
  contentRefs,
  onNextFeature,
}: FeatureMobileCardProps) {
  const isMobile = useIsMobile();
  const scale = textScale || 1;
  const titleFontSize = `calc(${isMobile ? 1.125 : 1.25}rem * ${scale})`;
  const titleLineHeight = `calc(${isMobile ? 1.6 : 1.75}rem * ${scale})`;
  const bodyFontSize = `calc(${isMobile ? 0.95 : 0.875}rem * ${scale})`;
  const bodyLineHeight = `calc(${isMobile ? 1.45 : 1.375}rem * ${scale})`;
  const visibleDetails = selectMobileDetails(feature, index, isMobile, isShortHeight);

  return (
    <div
      className={`absolute inset-0 transition-opacity duration-700 ${
        isActive ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <div className="relative h-full w-full">
        <FeatureMobileCardBody
          feature={feature}
          index={index}
          isActive={isActive}
          isShortHeight={isShortHeight}
          isMobile={isMobile}
          titleFontSize={titleFontSize}
          titleLineHeight={titleLineHeight}
          bodyFontSize={bodyFontSize}
          bodyLineHeight={bodyLineHeight}
          visibleDetails={visibleDetails}
          containerRefs={containerRefs}
          contentRefs={contentRefs}
        />
      </div>

      <div className="absolute right-2 bottom-2 z-30 pointer-events-auto">
        <button
          type="button"
          className="w-8 h-4 flex items-center justify-center animate-slow-bounce-half pointer-events-auto"
          aria-label="Scroll to next feature"
          onClick={onNextFeature}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#272725"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-4 h-4"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
