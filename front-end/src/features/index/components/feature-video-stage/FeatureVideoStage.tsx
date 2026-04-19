/**
 * STATE MACHINE: FeatureVideoStage
 *
 * VIDEO PLAYBACK PHASES:
 * [LOADING] <-- canPlay: false, markersLoaded: false
 *     |
 *     v (video + markers loaded)
 * [INTRO] --> play intro segment for feature
 *     |
 *     v (intro ends)
 * [CYCLING] --> loop between cycleStart and cycleEnd
 *     |
 *     | (feature changes)
 *     v
 * [OUTRO] --> play outro segment
 *     |
 *     v (outro ends)
 * [INTRO] (for new feature)
 *
 * Implementation is decomposed into:
 *   - useStageControls        : platform / debug flag refs
 *   - useVideoDebugFlags      : URL + localStorage -> control refs
 *   - useVideoMarkers         : fetch & normalize markers
 *   - useVideoPrefetch        : blob-prefetch master video
 *   - useVideoLoadingState    : track loading/ready events
 *   - useVideoWarmup          : seek-to-end prebuffer
 *   - useVideoStateMachine    : per-frame intro/cycle/outro driver
 *   - useVideoWatchdog        : debug-only freeze recovery
 *   - VideoStageLayout        : presentational JSX
 */

import { useRef } from 'react';

import { useStageControls } from '../../hooks/useStageControls';
import { useVideoDebugFlags } from '../../hooks/useVideoDebugFlags';
import { useVideoLoadingState } from '../../hooks/useVideoLoadingState';
import { useVideoMarkers } from '../../hooks/useVideoMarkers';
import { useVideoPrefetch } from '../../hooks/useVideoPrefetch';
import { useVideoStateMachine } from '../../hooks/useVideoStateMachine';
import { useVideoWarmup } from '../../hooks/useVideoWarmup';
import { useVideoWatchdog } from '../../hooks/useVideoWatchdog';
import type { FeatureVideoStageProps } from '../../types';
import VideoStageLayout from './VideoStageLayout';

export default function FeatureVideoStage({ activeIndex }: FeatureVideoStageProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controls = useStageControls();

  const debugEnabled = useVideoDebugFlags({
    disableRampRef: controls.disableRampRef,
    disableWarmupRef: controls.disableWarmupRef,
  });

  const { markers, normalized } = useVideoMarkers();
  const blobUrl = useVideoPrefetch({
    videoRef,
    isHevcRef: controls.isHevcRef,
    isIOSSafariRef: controls.isIOSSafariRef,
  });
  const isVideoLoading = useVideoLoadingState(videoRef);
  useVideoWarmup(videoRef, markers, controls.disableWarmupRef.current);
  useVideoStateMachine({
    videoRef,
    activeIndex,
    normalized,
    isHevcRef: controls.isHevcRef,
    isIOSSafariRef: controls.isIOSSafariRef,
    disableRampRef: controls.disableRampRef,
    memoryOffsetFramesRef: controls.memoryOffsetFramesRef,
  });
  useVideoWatchdog(videoRef, debugEnabled);

  return (
    <VideoStageLayout
      videoRef={videoRef}
      src={blobUrl || ''}
      isVideoLoading={isVideoLoading}
      isIOSSafari={controls.isIOSSafariRef.current}
    />
  );
}
