import { type ReactNode } from 'react';

import { FEATURES } from '../../config';
import type { FeatureItem } from '../../types';

/**
 * Returns the config `FEATURES` list with the "Privacy First" feature's
 * first detail augmented to include a JSX link to the privacy policy.
 */
export function resolveFeatures(): FeatureItem[] {
  return FEATURES.map((feature, index) => {
    if (index !== 4) return feature;
    const privacyLink: ReactNode = (
      <>
        Your conversations stay private. Rose never stores or sells your data. View our privacy
        policy{' '}
        <a
          href="/privacy"
          className="text-primary hover:text-primary/80 underline transition-colors"
        >
          here.
        </a>
      </>
    );
    return {
      ...feature,
      details: [privacyLink, ...feature.details.slice(1)],
    };
  });
}
