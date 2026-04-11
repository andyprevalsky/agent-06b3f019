import type React from 'react';

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

export interface ProgressiveImageProps {
  lowSrc: string;
  medSrc: string;
  highSrc: string;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
  fetchPriority?: 'high' | 'low' | 'auto';
}

export interface VideoPlayerProps {
  src: string;
  poster?: string;
  className?: string;
  style?: React.CSSProperties;
  objectFit?: 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';
  fallbackContent?: React.ReactNode;
  autoPlay?: boolean;
  loop?: boolean;
  muted?: boolean;
  preload?: 'none' | 'metadata' | 'auto';
  onLoad?: () => void;
  onFirstFrame?: () => void;
  priority?: boolean;
}

// ---------------------------------------------------------------------------
// Features video
// ---------------------------------------------------------------------------

export type FeatureKey = 'customization' | 'conversations' | 'engine' | 'memory' | 'privacy';

export interface Segment {
  introStart: number;
  introEnd: number;
  cycleStart: number;
  cycleEnd: number;
  outroStart: number;
  outroEnd: number;
  outroAnthropicStart?: number;
  outroAnthropicEnd?: number;
  outroGeminiStart?: number;
  outroGeminiEnd?: number;
  outroMetaStart?: number;
  outroMetaEnd?: number;
  outroDeepseakStart?: number;
  outroDeepseakEnd?: number;
}

export interface MarkersFile {
  fps: number;
  customization: Segment;
  conversations: Segment;
  engine: Segment;
  memory: Segment;
  privacy: Segment;
}

export interface FeatureVideoStageProps {
  activeIndex: number;
}

// ---------------------------------------------------------------------------
// Features section
// ---------------------------------------------------------------------------

export interface FeatureItem {
  title: string;
  description: string;
  details: Array<string | React.ReactNode>;
}

// ---------------------------------------------------------------------------
// Waitlist
// ---------------------------------------------------------------------------

export interface WaitlistSectionProps {
  customOnly?: boolean;
}

export interface WaitlistFormProps {
  onSuccess?: () => void;
  variant?: string;
}

// ---------------------------------------------------------------------------
// Loading animation
// ---------------------------------------------------------------------------

export interface VideoLoadingAnimationProps {
  isVisible: boolean;
}

// ---------------------------------------------------------------------------
// Waitlist API
// ---------------------------------------------------------------------------

export interface WaitlistPayload {
  name: string;
  email: string;
  variant: string | null;
}

export interface WaitlistResponse {
  success: boolean;
  message: string;
}
