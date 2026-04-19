import { useEffect, useRef } from 'react';

const VAPI_SAMPLE_RATE = 16000;
const INITIAL_BUFFER_SECONDS = 0.05;

interface LiveAudioOptions {
  status?: string;
  listenUrl?: string;
  isMuted: boolean;
}

/**
 * Connects to Vapi's live-audio WebSocket while the call is `in-progress` and
 * plays the incoming raw PCM stream. Cleans up on unmount / status change /
 * mute.
 *
 * Vapi sends stereo signed 16-bit little-endian PCM at 16kHz. Each chunk is
 * 1280 bytes (640 samples = 320 stereo frames) arriving every ~40 ms.
 */
export function useLiveAudio({ status, listenUrl, isMuted }: LiveAudioOptions): void {
  const audioContextRef = useRef<AudioContext | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (status !== 'in-progress' || !listenUrl || isMuted) {
      closeConnection(wsRef, audioContextRef);
      return;
    }

    try {
      const ws = new WebSocket(listenUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      void audioContext.resume();

      let nextPlayTime = 0;

      ws.onmessage = (event: MessageEvent) => {
        const ctx = audioContextRef.current;
        if (!ctx || ctx.state !== 'running') return;
        try {
          nextPlayTime = playChunk(ctx, event.data as ArrayBuffer, nextPlayTime);
        } catch (err) {
          console.error('Audio playback error:', err);
        }
      };

      ws.onerror = (err) => {
        console.error('WebSocket error for live audio:', err);
      };

      return () => closeConnection(wsRef, audioContextRef);
    } catch (err) {
      console.error('Failed to connect to live audio:', err);
      return undefined;
    }
  }, [status, listenUrl, isMuted]);
}

function closeConnection(
  wsRef: React.MutableRefObject<WebSocket | null>,
  audioContextRef: React.MutableRefObject<AudioContext | null>,
): void {
  if (wsRef.current) {
    wsRef.current.close();
    wsRef.current = null;
  }
  if (audioContextRef.current) {
    void audioContextRef.current.close();
    audioContextRef.current = null;
  }
}

function playChunk(ctx: AudioContext, data: ArrayBuffer, nextPlayTime: number): number {
  const pcmData = new Int16Array(data);
  const samplesPerChannel = pcmData.length / 2;
  const leftChannel = new Float32Array(samplesPerChannel);
  const rightChannel = new Float32Array(samplesPerChannel);

  for (let i = 0; i < samplesPerChannel; i++) {
    leftChannel[i] = pcmData[i * 2] / 32768;
    rightChannel[i] = pcmData[i * 2 + 1] / 32768;
  }

  const audioBuffer = ctx.createBuffer(2, samplesPerChannel, VAPI_SAMPLE_RATE);
  audioBuffer.getChannelData(0).set(leftChannel);
  audioBuffer.getChannelData(1).set(rightChannel);

  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(ctx.destination);

  const currentTime = ctx.currentTime;
  const startAt = nextPlayTime < currentTime ? currentTime + INITIAL_BUFFER_SECONDS : nextPlayTime;
  source.start(startAt);
  return startAt + audioBuffer.duration;
}
