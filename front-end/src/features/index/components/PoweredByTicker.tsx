/**
 * STATE MACHINE: PoweredByTicker
 *
 * This component is stateless - displays a CSS-animated logo ticker.
 *
 * [MOUNTED] --> renders ticker with CSS animations
 */

import openaiLogo from '@/assets/openai-logo.png';
import anthropicLogo from '@/assets/anthropic-logo.png';
import cerebrasLogo from '@/assets/cerebras-logo.png';
import elevenlabsLogo from '@/assets/elevenlabs-logo.png';
import googleAiLogo from '@/assets/google-ai-logo.png';
import metaLogo from '@/assets/meta-logo.png';
import deepgramLogo from '@/assets/deepgram-logo.png';
import hedraLogo from '@/assets/hedra-logo.png';
import ycombinatorLogo from '@/assets/ycombinator-logo.png';

const PoweredByTicker = () => {
  return (
    <section className="py-8 bg-background border-b border-border/50 relative z-20">
      <div className="container mx-auto px-6">
        <p className="text-center text-sm text-muted-foreground/60 mb-8 font-light">Powered by</p>
        <div className="w-full overflow-hidden">
          <div className="logo-ticker animate">
            <div className="ticker-track">
              <img
                src={openaiLogo}
                alt="OpenAI"
                className="provider-logo"
                style={{ maxHeight: '40px', minHeight: '40px' }}
              />
              <img
                src={anthropicLogo}
                alt="Anthropic"
                className="provider-logo"
                style={{ maxHeight: '24px', minHeight: '24px' }}
              />
              <img
                src={cerebrasLogo}
                alt="Cerebras"
                className="provider-logo"
                style={{ maxHeight: '52px', minHeight: '52px' }}
              />
              <img
                src={elevenlabsLogo}
                alt="ElevenLabs"
                className="provider-logo elevenlabs-logo"
                style={{ maxHeight: '24px', minHeight: '24px' }}
              />
              <img
                src={googleAiLogo}
                alt="Google AI"
                className="provider-logo"
                style={{ maxHeight: '40px', minHeight: '40px', marginBottom: '8px' }}
              />
              <img
                src={metaLogo}
                alt="Meta"
                className="provider-logo"
                style={{ maxHeight: '24px', minHeight: '24px' }}
              />
              <img
                src={deepgramLogo}
                alt="Deepgram"
                className="provider-logo"
                style={{ maxHeight: '32px', minHeight: '32px', marginTop: '8px' }}
              />
              <img
                src={hedraLogo}
                alt="Hedra"
                className="provider-logo"
                style={{ maxHeight: '40px', minHeight: '40px' }}
              />
              <img
                src={ycombinatorLogo}
                alt="Y Combinator"
                className="provider-logo"
                style={{ maxHeight: '40px', minHeight: '40px' }}
              />
              <img
                src={openaiLogo}
                alt="OpenAI"
                className="provider-logo"
                style={{ maxHeight: '40px', minHeight: '40px' }}
              />
              <img
                src={anthropicLogo}
                alt="Anthropic"
                className="provider-logo"
                style={{ maxHeight: '24px', minHeight: '24px' }}
              />
              <img
                src={cerebrasLogo}
                alt="Cerebras"
                className="provider-logo"
                style={{ maxHeight: '52px', minHeight: '52px' }}
              />
              <img
                src={elevenlabsLogo}
                alt="ElevenLabs"
                className="provider-logo elevenlabs-logo"
                style={{ maxHeight: '24px', minHeight: '24px' }}
              />
              <img
                src={googleAiLogo}
                alt="Google AI"
                className="provider-logo"
                style={{ maxHeight: '40px', minHeight: '40px', marginBottom: '8px' }}
              />
              <img
                src={metaLogo}
                alt="Meta"
                className="provider-logo"
                style={{ maxHeight: '24px', minHeight: '24px' }}
              />
              <img
                src={deepgramLogo}
                alt="Deepgram"
                className="provider-logo"
                style={{ maxHeight: '32px', minHeight: '32px', marginTop: '8px' }}
              />
              <img
                src={hedraLogo}
                alt="Hedra"
                className="provider-logo"
                style={{ maxHeight: '40px', minHeight: '40px' }}
              />
              <img
                src={ycombinatorLogo}
                alt="Y Combinator"
                className="provider-logo"
                style={{ maxHeight: '40px', minHeight: '40px' }}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default PoweredByTicker;
