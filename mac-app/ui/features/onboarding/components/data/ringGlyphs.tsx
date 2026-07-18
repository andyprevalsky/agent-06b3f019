/**
 * STATE MACHINE: ringGlyphs (pure presentation)
 *
 * [GREY] --category connected--> [ROSE_GRADIENT] (via CSS stroke override)
 *
 * System context:
 *   RingCarousel renders one grey lucide glyph per category (same grey as the
 *   Rose tool-set icons in the query box, text-muted-foreground). When the
 *   category connects, onboarding-ring.css swaps the stroke to the shared
 *   rose gradient defined by <RoseGlyphDefs />.
 */

import { Cpu, DollarSign, Globe, KeyRound, MessageSquare, Share2 } from 'lucide-react';
import type { JSX } from 'react';

const GLYPH_CLASS = 'h-[30px] w-[30px]';

export const RING_GLYPHS: Record<string, JSX.Element> = {
  browsers: <Globe className={GLYPH_CLASS} />,
  passwords: <KeyRound className={GLYPH_CLASS} />,
  compute: <Cpu className={GLYPH_CLASS} />,
  messages: <MessageSquare className={GLYPH_CLASS} />,
  socials: <Share2 className={GLYPH_CLASS} />,
  financials: <DollarSign className={GLYPH_CLASS} />,
};

/**
 * Shared SVG paint for connected ring glyphs. userSpaceOnUse over the 24x24
 * lucide viewBox — objectBoundingBox gradients cannot paint zero-height paths
 * (e.g. the globe's horizontal `M2 12h20` line).
 */
export function RoseGlyphDefs(): JSX.Element {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <linearGradient
          id="onbRoseGlyphG"
          gradientUnits="userSpaceOnUse"
          x1="24"
          y1="0"
          x2="0"
          y2="24"
        >
          <stop offset="0%" stopColor="#FE7503" />
          <stop offset="20%" stopColor="#FC585C" />
          <stop offset="40%" stopColor="#FD5776" />
          <stop offset="60%" stopColor="#E062CC" />
          <stop offset="80%" stopColor="#A76CED" />
          <stop offset="100%" stopColor="#7A6BEC" />
        </linearGradient>
      </defs>
    </svg>
  );
}
