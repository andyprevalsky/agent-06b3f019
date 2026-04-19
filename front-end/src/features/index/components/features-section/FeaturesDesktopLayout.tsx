import FeatureVideoStage from '../FeatureVideoStage';

import FeatureMenuItem from './FeatureMenuItem';
import type { FeatureItem } from '../../types';
import { navigateToWaitlistOrPreOrder } from './waitlistNavigation';

interface FeaturesDesktopLayoutProps {
  features: FeatureItem[];
  activeFeature: number;
  earlyAccess: boolean;
  onFeatureClick: (index: number) => void;
}

/**
 * Desktop/large layout: sticky video stage + right-side sticky menu of
 * feature titles. Scroll sentinels allocate vertical space to pace the
 * scroll-driven highlight.
 */
export default function FeaturesDesktopLayout({
  features,
  activeFeature,
  earlyAccess,
  onFeatureClick,
}: FeaturesDesktopLayoutProps) {
  return (
    <div className="hidden lg:block max-w-7xl mx-auto relative">
      <div className="flex gap-12 min-h-[600vh] relative z-10">
        <div className="flex-1 flex justify-center relative z-20">
          <div className="" style={{ width: '840px' }}>
            <div className="sticky top-24">
              <div className="w-full h-[780px] flex items-center justify-center relative">
                <FeatureVideoStage activeIndex={activeFeature} />
              </div>
            </div>
            <div className="lg:block hidden">
              {features.map((_, i) => (
                <div
                  key={`desktop-sentinel-${i}`}
                  data-sentinel-index={i}
                  id={`feature-sentinel-${i}`}
                  className="h-[180vh]"
                  aria-hidden="true"
                />
              ))}
            </div>
          </div>
        </div>

        <div className="w-[400px] relative z-20">
          <div className="sticky top-24">
            <div className="bg-surface/30 backdrop-blur-sm rounded-2xl border border-gray-200">
              {features.map((feature, index) => (
                <FeatureMenuItem
                  key={feature.title}
                  feature={feature}
                  index={index}
                  isActive={activeFeature === index}
                  onSelect={onFeatureClick}
                />
              ))}
            </div>

            <button
              onClick={() => navigateToWaitlistOrPreOrder(earlyAccess)}
              className="relative w-full text-left p-4 rounded-lg transition-all duration-300 overflow-hidden border-2 border-transparent mt-2"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC] bg-[length:200%_200%] animate-gradient-rotate rounded-lg"></div>
              <h4 className="relative font-medium text-sm leading-tight text-white z-10">
                {earlyAccess ? 'Pre-order' : 'Join the Waitlist'}
              </h4>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
