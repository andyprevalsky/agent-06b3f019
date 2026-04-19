/**
 * STATE MACHINE: PoweredByTicker
 *
 * This component is stateless - displays a CSS-animated logo ticker.
 *
 * [MOUNTED] --> renders ticker with CSS animations
 */

import type { CSSProperties } from 'react';

import openaiLogo from '@/assets/openai-logo.png';
import anthropicLogo from '@/assets/anthropic-logo.png';
import cerebrasLogo from '@/assets/cerebras-logo.png';
import elevenlabsLogo from '@/assets/elevenlabs-logo.png';
import googleAiLogo from '@/assets/google-ai-logo.png';
import metaLogo from '@/assets/meta-logo.png';
import deepgramLogo from '@/assets/deepgram-logo.png';
import hedraLogo from '@/assets/hedra-logo.png';
import ycombinatorLogo from '@/assets/ycombinator-logo.png';

interface ProviderLogo {
  src: string;
  alt: string;
  style: CSSProperties;
  extraClass?: string;
}

const PROVIDER_LOGOS: ProviderLogo[] = [
  { src: openaiLogo, alt: 'OpenAI', style: { maxHeight: '40px', minHeight: '40px' } },
  { src: anthropicLogo, alt: 'Anthropic', style: { maxHeight: '24px', minHeight: '24px' } },
  { src: cerebrasLogo, alt: 'Cerebras', style: { maxHeight: '52px', minHeight: '52px' } },
  {
    src: elevenlabsLogo,
    alt: 'ElevenLabs',
    style: { maxHeight: '24px', minHeight: '24px' },
    extraClass: 'elevenlabs-logo',
  },
  {
    src: googleAiLogo,
    alt: 'Google AI',
    style: { maxHeight: '40px', minHeight: '40px', marginBottom: '8px' },
  },
  { src: metaLogo, alt: 'Meta', style: { maxHeight: '24px', minHeight: '24px' } },
  {
    src: deepgramLogo,
    alt: 'Deepgram',
    style: { maxHeight: '32px', minHeight: '32px', marginTop: '8px' },
  },
  { src: hedraLogo, alt: 'Hedra', style: { maxHeight: '40px', minHeight: '40px' } },
  { src: ycombinatorLogo, alt: 'Y Combinator', style: { maxHeight: '40px', minHeight: '40px' } },
];

// Duplicate logos so the CSS-animated ticker can loop seamlessly.
const TICKER_LOGOS: ProviderLogo[] = [...PROVIDER_LOGOS, ...PROVIDER_LOGOS];

const PoweredByTicker = () => {
  return (
    <section className="py-8 bg-background border-b border-border/50 relative z-20">
      <div className="container mx-auto px-6">
        <p className="text-center text-sm text-muted-foreground/60 mb-8 font-light">Powered by</p>
        <div className="w-full overflow-hidden">
          <div className="logo-ticker animate">
            <div className="ticker-track">
              {TICKER_LOGOS.map((logo, index) => (
                <img
                  key={`${logo.alt}-${index}`}
                  src={logo.src}
                  alt={logo.alt}
                  className={`provider-logo${logo.extraClass ? ` ${logo.extraClass}` : ''}`}
                  style={logo.style}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default PoweredByTicker;
