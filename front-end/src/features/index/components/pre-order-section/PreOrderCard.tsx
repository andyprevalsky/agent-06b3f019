import { type RefObject } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

import ServiceFeePopover from './ServiceFeePopover';

export interface PreOrderCardProps {
  title: string;
  description: string;
  videoSrc: string;
  posterSrc: string;
  altText: string;
  cardClassName: string;
  buttonClassName: string;
  cardRevealDelay: string;
  wrapperRef: (node: HTMLDivElement | null) => void;
  videoRef: RefObject<HTMLVideoElement>;
  inView: boolean;
  onPreOrder: () => void;
}

/**
 * A single pre-order card (Midnight Black or Pearl White). Lazily
 * loads its video source only after the wrapper enters the viewport.
 */
export default function PreOrderCard({
  title,
  description,
  videoSrc,
  posterSrc,
  altText,
  cardClassName,
  buttonClassName,
  cardRevealDelay,
  wrapperRef,
  videoRef,
  inView,
  onPreOrder,
}: PreOrderCardProps) {
  return (
    <div className="w-full">
      <Card
        className={`group transition-all duration-500 hover:shadow-[var(--shadow-luxury)] hover:scale-105 reveal-up ${cardRevealDelay} ${cardClassName}`}
      >
        <CardContent className="p-8 text-center">
          <div className="mb-6">
            <div
              ref={wrapperRef}
              className="w-72 h-72 rounded-3xl mx-auto mb-4 overflow-hidden bg-surface"
            >
              <video
                ref={videoRef}
                autoPlay
                className="w-full h-full object-cover"
                loop
                muted
                playsInline
                preload={inView ? 'auto' : 'none'}
                poster={posterSrc}
              >
                {inView && <source src={videoSrc} type="video/webm" />}
                <img
                  src={posterSrc}
                  alt={altText}
                  className="w-full h-full object-cover"
                />
              </video>
            </div>
            <h3 className="text-2xl font-semibold mb-2">{title}</h3>
            <p className="text-muted-foreground">{description}</p>
          </div>

          <div className="mb-8">
            <div className="text-3xl font-light tracking-tight">
              $199 +
              <ServiceFeePopover />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="mt-6">
        <Button onClick={onPreOrder} className={`${buttonClassName} w-full`} size="lg">
          Pre-order
        </Button>
        <p className="text-xs text-muted-foreground mt-4 text-center">
          Free shipping • 30-day returns
        </p>
      </div>
    </div>
  );
}
