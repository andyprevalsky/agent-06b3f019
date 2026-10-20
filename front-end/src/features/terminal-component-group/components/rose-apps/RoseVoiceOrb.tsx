/**
 * STATE MACHINE: RoseVoiceOrb
 *
 *   [MOUNT] -> looping muted orb video -> [PLAYING]
 *   [PLAYING] --hue prop changes--> hue-rotate retints the whole orb -> [PLAYING]
 *
 * The onboarding voice orb (same asset as mac-app VoiceOrb, transcoded to a
 * small 400x300 loop in /voice-orb.mp4), rose-tinted by multiplying the video
 * over a pale-pink radial gradient and clipped to the orb itself — no tile,
 * ring or chip around it. With `mic`, a white mic icon sits on top, lifted by
 * a two-layer drop shadow.
 */

import { useEffect, useRef } from 'react';
import { Mic } from 'lucide-react';

const ROSE_ORB_TINT =
  'radial-gradient(circle at 34% 28%, #fffafb 0%, #ffe3eb 45%, #fcc4d4 82%, #f7a8bf 100%)';
const MIC_SHADOW = 'drop-shadow(0 1px 1px rgba(0,0,0,.4)) drop-shadow(0 4px 8px rgba(0,0,0,.28))';

function resolveVoiceOrbSrc(baseUrl: string = import.meta.env.BASE_URL): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${normalizedBase}voice-orb.mp4`;
}

interface RoseVoiceOrbProps {
  size: number;
  hue?: number;
  mic?: boolean;
  /** Mic icon color; the app bar turns it rose (#e8507f) while Voice is open. */
  micColor?: string;
}

export function RoseVoiceOrb({
  size,
  hue = 0,
  mic = false,
  micColor = '#ffffff',
}: RoseVoiceOrbProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (video === null || typeof video.play !== 'function') return;
    // play() is absent/unimplemented in some test DOMs; autoplay covers browsers.
    try {
      void video.play()?.catch(() => {});
    } catch {
      // ignored: autoplay attribute still starts playback where supported
    }
  }, []);
  const micSize = Math.round(size * 0.42);
  return (
    <span
      data-testid="rose-voice-orb"
      className="relative grid flex-none place-items-center"
      style={{ width: size, height: size }}
    >
      <span
        className="absolute inset-0 overflow-hidden rounded-full"
        style={{ background: ROSE_ORB_TINT, filter: `hue-rotate(${hue}deg)`, isolation: 'isolate' }}
      >
        <video
          ref={videoRef}
          src={resolveVoiceOrbSrc()}
          autoPlay
          loop
          muted
          playsInline
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-[49%] max-w-none -translate-x-1/2 -translate-y-1/2"
          style={{ width: '212%', height: '159%', mixBlendMode: 'multiply' }}
        />
      </span>
      {mic && (
        <Mic
          aria-hidden="true"
          data-testid="rose-voice-orb-mic"
          className="relative"
          strokeWidth={2.3}
          style={{ width: micSize, height: micSize, color: micColor, filter: MIC_SHADOW }}
        />
      )}
    </span>
  );
}
