import { useEffect } from 'react';

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
  useEffect(() => {
    if (status !== 'in-progress' || !listenUrl || isMuted) return;
    let ws: WebSocket | null = null;
    let audioContext: AudioContext | null = null;
    let closed = false;
    const closeConnection = () => {
      closed = true;
      if (ws) {
        ws.onmessage = null;
        ws.onerror = null;
        ws.close();
        ws = null;
      }
      if (audioContext) {
        void audioContext.close();
        audioContext = null;
      }
    };

    try {
      ws = new WebSocket(listenUrl);
      ws.binaryType = 'arraybuffer';

      audioContext = new AudioContext();
      void audioContext.resume();

      let nextPlayTime = 0;

      ws.onmessage = (event: MessageEvent) => {
        const ctx = audioContext;
        if (closed || !ctx || ctx.state !== 'running') return;
        try {
          nextPlayTime = playChunk(ctx, event.data as ArrayBuffer, nextPlayTime);
        } catch (err) {
          console.error('Audio playback error:', err);
        }
      };

      ws.onerror = (err) => {
        console.error('WebSocket error for live audio:', err);
      };

      return closeConnection;
    } catch (err) {
      closeConnection();
      console.error('Failed to connect to live audio:', err);
      return undefined;
    }
  }, [status, listenUrl, isMuted]);
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
