/**
 * STATE MACHINE: VoiceOrb
 *
 *   [MOUNT] → load looping video → [PLAYING]
 *   [PLAYING] ─(hue prop changes)→ CSS hue-rotate retints frames → [PLAYING]
 *
 * The asset is a pre-rendered orb animation served from the Vite public dir.
 * `objectFit: cover` keeps the orb at full size (the source is 4:3 with the
 * orb centered), and a circular clip-path crops just outside the orb's
 * bounds to hide the white background.
 * Per-voice color comes from a CSS hue-rotate over the video frames.
 */

import { useEffect, useRef } from 'react';

interface VoiceOrbProps {
  hue: number;
  size?: number;
}

export const resolveVoiceOrbSrc = (baseUrl: string = import.meta.env.BASE_URL): string => {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${normalizedBase}voice-orb.mp4`;
};

const VoiceOrb = ({ hue, size = 220 }: VoiceOrbProps): JSX.Element => {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    void video.play().catch(() => {});
  }, []);

  return (
    <video
      ref={videoRef}
      src={resolveVoiceOrbSrc()}
      autoPlay
      loop
      muted
      playsInline
      style={{
        width: size,
        height: size,
        filter: `hue-rotate(${hue}deg)`,
        objectFit: 'cover',
        clipPath: 'circle(30% at 50% 50%)',
        background: 'transparent',
      }}
      className="voice-orb-video"
      aria-hidden="true"
    />
  );
};

export default VoiceOrb;
