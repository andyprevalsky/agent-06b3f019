/**
 * STATE MACHINE: WaitlistSection
 *
 * This component is stateless - renders child components (WaitlistForm, VideoPlayer).
 * State is managed by child components.
 *
 * Props:
 * - customOnly: boolean (controls which form variant to show)
 *
 * [MOUNTED] --> renders section with WaitlistForm and VideoPlayer
 */

import { Card, CardContent } from '@/components/ui/card';
import WaitlistForm from './WaitlistForm';
import VideoPlayer from './VideoPlayer';

import type { WaitlistSectionProps } from '../types';

// ---------------------------------------------------------------------------
// Header (title + 3-variant swatches)
// ---------------------------------------------------------------------------

const variantSwatches = [
  { title: 'Midnight Black', style: { backgroundColor: '#010203' }, border: false },
  { title: 'Pearl White', style: { backgroundColor: '#F0F0FF' }, border: true },
  {
    title: 'Custom',
    style: {
      background: 'linear-gradient(135deg, #A76CED, #E062CC, #FD5776, #FE7503)',
    },
    border: false,
  },
] as const;

const WaitlistHeader = ({ customOnly }: { customOnly: boolean }) => (
  <div className="text-center mb-16">
    <h2 className="text-5xl font-light tracking-tight mb-6 reveal-up">
      <span className="gradient-text">Join the Waitlist</span>
    </h2>
    <p className="text-xl text-muted-foreground max-w-2xl mx-auto reveal-up reveal-delay-1">
      Be among the first to experience the future of voice AI. Join our waitlist and we'll notify
      you when you are next in line.
    </p>

    {!customOnly && (
      <div className="text-center mt-8 mb-8 reveal-up reveal-delay-2">
        <p className="text-sm text-muted-foreground mb-3">Available in 3 variations</p>
        <div className="flex justify-center space-x-6">
          {variantSwatches.map((v) => (
            <div key={v.title} className="group relative flex flex-col items-center">
              <div
                className={`w-3 h-3 rounded-full transition-transform duration-200 hover:scale-140 cursor-pointer${
                  v.border ? ' border border-gray-300' : ''
                }`}
                style={v.style}
                title={v.title}
              ></div>
              <span className="absolute top-6 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity duration-300 whitespace-nowrap">
                {v.title}
              </span>
            </div>
          ))}
        </div>
      </div>
    )}
  </div>
);

// ---------------------------------------------------------------------------
// Variant cards
// ---------------------------------------------------------------------------

interface VariantCardProps {
  cardClass: string;
  revealDelay: string;
  videoSrc: string;
  posterSrc: string;
  altText: string;
  title: string;
  description: string;
  formVariant: string;
}

const VariantCard = ({
  cardClass,
  revealDelay,
  videoSrc,
  posterSrc,
  altText,
  title,
  description,
  formVariant,
}: VariantCardProps) => (
  <div className="w-full">
    <Card
      className={`group ${cardClass} border-border/50 transition-all duration-500 hover:shadow-[var(--shadow-luxury)] hover:scale-105 reveal-up ${revealDelay}`}
    >
      <CardContent className="p-8 text-center">
        <div className="mb-6">
          <div className="w-72 h-72 rounded-3xl mx-auto mb-4 overflow-hidden bg-surface">
            <VideoPlayer
              src={videoSrc}
              poster={posterSrc}
              className="w-full h-full object-cover"
              fallbackContent={
                <img src={posterSrc} alt={altText} className="w-full h-full object-cover" />
              }
            />
          </div>
          <h3 className="text-2xl font-semibold mb-2">{title}</h3>
          <p className="text-muted-foreground">{description}</p>
        </div>
      </CardContent>
    </Card>
    <div className="mt-6">
      <WaitlistForm variant={formVariant} onSuccess={() => {}} />
      <p className="text-xs text-muted-foreground mt-4 text-center">
        No commitment • Early access updates
      </p>
    </div>
  </div>
);

const CustomCard = ({ customOnly }: { customOnly: boolean }) => (
  <div className={`w-full ${customOnly ? 'max-w-xl mx-auto' : ''}`}>
    <Card className="group bg-card border-border/50 hover:border-primary/30 transition-all duration-500 hover:shadow-[var(--shadow-luxury)] hover:scale-105 reveal-up reveal-delay-3">
      <CardContent className="p-8 text-center">
        <div className="mb-6">
          <div className="w-72 h-72 rounded-3xl mx-auto mb-4 overflow-hidden bg-gradient-to-br from-purple-100 to-orange-100 flex items-center justify-center">
            <div className="text-6xl font-light text-transparent bg-gradient-to-br from-[#A76CED] via-[#E062CC] to-[#FE7503] bg-clip-text">
              ?
            </div>
          </div>
          <h3 className="text-2xl font-semibold mb-2">Custom</h3>
          <p className="text-muted-foreground">
            Bring your favorite character to life with a custom design, voice & personality
          </p>
        </div>
      </CardContent>
    </Card>
    <div className={`mt-6 ${customOnly ? 'max-w-xl mx-auto' : ''}`}>
      <WaitlistForm variant="custom" onSuccess={() => {}} />
      <p className="text-xs text-muted-foreground mt-4 text-center">
        No commitment • Early access updates
      </p>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Main section
// ---------------------------------------------------------------------------

const WaitlistSection = ({ customOnly = false }: WaitlistSectionProps) => {
  return (
    <section
      id="waitlist"
      className="relative z-10 py-32 bg-gradient-to-b from-surface to-background overflow-hidden"
    >
      <div
        className="absolute -top-24 left-0 right-0 h-24 bg-gradient-to-b from-surface to-transparent z-0 pointer-events-none"
        aria-hidden="true"
      ></div>
      <div
        className="absolute top-0 left-0 right-0 h-16 bg-gradient-to-b from-transparent to-surface z-20 pointer-events-none"
        aria-hidden="true"
      ></div>
      <div className="relative z-10 container mx-auto px-6">
        <WaitlistHeader customOnly={customOnly} />

        <div
          className={`grid grid-cols-1 ${customOnly ? 'md:grid-cols-1' : 'md:grid-cols-3'} gap-8 max-w-6xl mx-auto`}
        >
          {!customOnly && (
            <VariantCard
              cardClass="bg-card hover:border-primary/30"
              revealDelay="reveal-delay-1"
              videoSrc="/navi-black-v4-white-background.webm"
              posterSrc="/navi-midnight-black-white-background.png"
              altText="Rose Black"
              title="Midnight Black"
              description="Precision matte coating with subtle metallic undertones"
              formVariant="midnight_black"
            />
          )}

          {!customOnly && (
            <VariantCard
              cardClass="bg-surface-elevated hover:border-space-gray/30"
              revealDelay="reveal-delay-2"
              videoSrc="/navi-white-v4-white-background.webm"
              posterSrc="/navi-pearl-white-white-background.png"
              altText="Rose White"
              title="Pearl White"
              description="Lustrous ceramic-like finish that captures and reflects light"
              formVariant="pearl_white"
            />
          )}

          <CustomCard customOnly={customOnly} />
        </div>

        <div className="text-center mt-12 reveal-up reveal-delay-3">
          <p className="text-sm text-muted-foreground mb-4">
            Expected launch: Q4 2025 • Join early for exclusive updates
          </p>
        </div>
      </div>
    </section>
  );
};

export default WaitlistSection;
