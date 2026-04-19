import { type MutableRefObject, type ReactNode } from 'react';

import { FEATURE_ICONS, HERO_BLACK, PEARL_BLUE } from '../../config';
import type { FeatureItem } from '../../types';

interface FeatureMobileCardBodyProps {
  feature: FeatureItem;
  index: number;
  isActive: boolean;
  isShortHeight: boolean;
  isMobile: boolean;
  titleFontSize: string;
  titleLineHeight: string;
  bodyFontSize: string;
  bodyLineHeight: string;
  visibleDetails: FeatureItem['details'];
  containerRefs: MutableRefObject<Array<HTMLDivElement | null>>;
  contentRefs: MutableRefObject<Array<HTMLUListElement | null>>;
}

function overrideDetailText(
  detail: ReactNode,
  index: number,
  detailIndex: number,
  isMobile: boolean,
): ReactNode {
  if (index === 4 && detailIndex === 1) {
    return 'Rose does not passively listen, active listening is enabled only by the customizable wake word, "Hi Rose".';
  }
  if (isMobile && index === 3 && detailIndex === 2) {
    return 'Time based queries keep Rose working in the background.';
  }
  return detail;
}

/** The card's inner chrome: icon, title, and bullet list. */
export default function FeatureMobileCardBody({
  feature,
  index,
  isActive,
  isShortHeight,
  isMobile,
  titleFontSize,
  titleLineHeight,
  bodyFontSize,
  bodyLineHeight,
  visibleDetails,
  containerRefs,
  contentRefs,
}: FeatureMobileCardBodyProps) {
  const activeBg = isActive ? PEARL_BLUE : '#ffffff';
  const activeIconBg = isActive ? HERO_BLACK : '#d1d5db';
  const titleGap = !isShortHeight ? '1.25rem' : '0.75rem';

  return (
    <div
      className="h-full w-full border rounded-none shadow-lg"
      style={{
        backgroundColor: activeBg,
        transition: 'background-color 2000ms ease',
        borderColor: HERO_BLACK,
      }}
    >
      <div ref={(el) => (containerRefs.current[index] = el)} className="p-6">
        <div className="flex items-center gap-3" style={{ marginBottom: titleGap }}>
          <div
            className="border p-1 flex items-center justify-center"
            style={{
              width: '2.25rem',
              height: '2.25rem',
              backgroundColor: activeIconBg,
              transition: 'background-color 2000ms ease',
              borderColor: HERO_BLACK,
            }}
          >
            <img
              src={`/${FEATURE_ICONS[index]}`}
              alt=""
              className="w-full h-full object-contain"
              style={{ filter: 'brightness(0) invert(1)', transition: 'none' }}
            />
          </div>
          <h3
            className="font-semibold text-foreground text-left"
            style={{ fontSize: titleFontSize, lineHeight: titleLineHeight }}
          >
            {feature.title}
          </h3>
        </div>

        {feature.details.length > 0 && (
          <ul
            ref={(el) => (contentRefs.current[index] = el)}
            className="space-y-3 text-left"
            style={{ fontSize: bodyFontSize, lineHeight: bodyLineHeight }}
          >
            {visibleDetails.map((detail, detailIndex) => (
              <li key={detailIndex} className="flex items-start space-x-3">
                <div
                  className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 transition-colors duration-1000"
                  style={{ backgroundColor: activeIconBg }}
                ></div>
                <span className="text-foreground/80 leading-relaxed">
                  {overrideDetailText(detail, index, detailIndex, isMobile)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
