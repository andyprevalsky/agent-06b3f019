import WebSocket from 'ws';

import { ELEVENLABS_REALTIME_STT_URL } from './config';
import { createLogger } from '../../providers/logger';

const log = createLogger('VapiHoldStt');

/** Audio buffered while the transcriber socket is still opening (~5 s of μ-law). */
const PENDING_AUDIO_BYTE_LIMIT = 40_000;

export interface TranscriberHandlers {
  onCommitted: (text: string) => void;
  onClosed: (error?: Error) => void;
}

export interface RealtimeTranscriber {
  sendAudio: (mulaw8k: Buffer) => void;
  close: () => void;
}

export type TranscriberFactory = (handlers: TranscriberHandlers) => RealtimeTranscriber;

export function elevenLabsRealtimeUrl(): string {
  const params = new URLSearchParams({
    model_id: 'scribe_v2_realtime',
    audio_format: 'ulaw_8000',
    commit_strategy: 'vad',
    vad_silence_threshold_secs: '0.8',
    language_code: 'en',
  });
  return `${ELEVENLABS_REALTIME_STT_URL}?${params.toString()}`;
}

/** ElevenLabs Scribe realtime over websocket; one socket per parked call. */
export function createElevenLabsTranscriberFactory(apiKey: string): TranscriberFactory {
  return (handlers) => {
    const socket = new WebSocket(elevenLabsRealtimeUrl(), { headers: { 'xi-api-key': apiKey } });
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let closedByCaller = false;
    let reportedClose = false;

    const reportClose = (error?: Error): void => {
      if (reportedClose) return;
      reportedClose = true;
      if (!closedByCaller) handlers.onClosed(error);
    };

    const send = (chunk: Buffer): void => {
      socket.send(
        JSON.stringify({
          message_type: 'input_audio_chunk',
          audio_base_64: chunk.toString('base64'),
          commit: false,
          sample_rate: 8000,
        })
      );
    };

    socket.on('open', () => {
      for (const chunk of pending) send(chunk);
      pending = [];
      pendingBytes = 0;
    });
    socket.on('message', (raw) => {
      let message: { message_type?: string; text?: string; error?: string };
      try {
        message = JSON.parse(raw.toString()) as typeof message;
      } catch {
        return;
      }
      if (message.message_type === 'committed_transcript') {
        const text = (message.text ?? '').trim();
        if (text !== '') handlers.onCommitted(text);
        return;
      }
      if (typeof message.message_type === 'string' && message.message_type.includes('error')) {
        log.warn('Realtime STT error message', {
          type: message.message_type,
          error: String(message.error ?? '').slice(0, 200),
        });
      }
    });
    socket.on('error', (error) => {
      log.warn('Realtime STT socket error', { error: error.message });
      reportClose(error);
    });
    socket.on('close', (code) => {
      reportClose(code === 1000 ? undefined : new Error(`STT socket closed (${code})`));
    });

    return {
      sendAudio: (chunk) => {
        if (socket.readyState === WebSocket.OPEN) {
          send(chunk);
          return;
        }
        if (socket.readyState !== WebSocket.CONNECTING) return;
        pending.push(chunk);
        pendingBytes += chunk.length;
        while (pendingBytes > PENDING_AUDIO_BYTE_LIMIT && pending.length > 1) {
          pendingBytes -= pending.shift()?.length ?? 0;
        }
      },
      close: () => {
        closedByCaller = true;
        if (socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
          return;
        }
        socket.close(1000);
      },
    };
  };
}
