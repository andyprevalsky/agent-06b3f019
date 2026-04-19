/**
 * Stateless layout for FeatureVideoStage.
 *
 * STATE MACHINE: presentational only — no state.
 * [LOADING] isVideoLoading:true  → shows VideoLoadingAnimation overlay
 * [READY]   isVideoLoading:false → shows <video> at full opacity
 */

import type { CSSProperties, Ref } from 'react';

import VideoLoadingAnimation from '../VideoLoadingAnimation';

export interface VideoStageLayoutProps {
  videoRef: Ref<HTMLVideoElement>;
  src: string;
  isVideoLoading: boolean;
  isIOSSafari: boolean;
}

export default function VideoStageLayout({
  videoRef,
  src,
  isVideoLoading,
  isIOSSafari,
}: VideoStageLayoutProps) {
  const outerStyle: CSSProperties = {
    overflow: isIOSSafari ? 'visible' : undefined,
  };
  const videoStyle: CSSProperties = {
    backgroundColor: 'transparent',
    opacity: isVideoLoading ? 0 : 1,
    transition: 'opacity 300ms ease-in-out',
    borderRadius: isIOSSafari ? 16 : undefined,
  };
  return (
    <div className="w-full h-full relative overflow-hidden rounded-2xl" style={outerStyle}>
      <div
        className="absolute inset-0 origin-center lg:scale-[0.78]"
        style={{ transformOrigin: 'center center' }}
      >
        <video
          ref={videoRef}
          className="w-full h-full object-contain"
          style={videoStyle}
          playsInline
          muted
          preload="auto"
          autoPlay
          src={src}
        />
        <VideoLoadingAnimation isVisible={isVideoLoading} />
      </div>
    </div>
  );
}
