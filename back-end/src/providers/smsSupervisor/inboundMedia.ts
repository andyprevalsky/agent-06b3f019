/**
 * Inbound MMS media processing for the SMS supervisor.
 *
 * Turns Surge attachment URLs into LLM-ready inputs:
 *   - images  → base64 `image_url` content blocks (multimodal user message)
 *   - audio   → transcript text via an audio-capable model (voice notes)
 *   - other   → a note line so the model can tell the user what it received
 *
 * All failures degrade to note lines — an undownloadable or untranscribable
 * attachment must never crash the supervisor run.
 */

import { createLogger } from '../logger';
import type { ContentBlock } from '../rose';

const log = createLogger('SmsInboundMedia');

/** Media attachment on an inbound Surge message (MMS photo, voice note, etc.). */
export interface SurgeAttachment {
  url: string;
  /** Content-type hint from the webhook payload (e.g. "image/jpeg"), if present. */
  type: string | null;
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // MMS media is small; 20MB is a generous cap
// scribe_v2 is the current batch STT model ($0.22/hr); scribe_v1 is removed
// 2026-07-09, and scribe_v2_realtime ($0.39/hr) only pays off for streaming.
const STT_MODEL = 'scribe_v2';

export interface ProcessedInboundMedia {
  /** One `image_url` content block per downloadable image attachment. */
  imageBlocks: ContentBlock[];
  /** Transcripts and status notes to append to the inbound message text. */
  noteLines: string[];
}

/**
 * Download and classify all attachments on an inbound message.
 * Never throws — every attachment resolves to an image block or a note line.
 */
export async function processInboundAttachments(
  attachments: SurgeAttachment[]
): Promise<ProcessedInboundMedia> {
  const imageBlocks: ContentBlock[] = [];
  const noteLines: string[] = [];

  for (const attachment of attachments) {
    try {
      const downloaded = await downloadAttachment(attachment);
      if (!downloaded) {
        noteLines.push('[Attachment received but it could not be downloaded]');
        continue;
      }

      const { buffer, mimeType } = downloaded;

      if (mimeType.startsWith('image/')) {
        imageBlocks.push({
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` },
        });
        continue;
      }

      if (mimeType.startsWith('audio/')) {
        const transcript = await transcribeVoiceNote(buffer, mimeType);
        noteLines.push(
          transcript
            ? `[Voice note transcript]: ${transcript}`
            : '[Voice note received but it could not be transcribed]'
        );
        continue;
      }

      noteLines.push(`[Attachment of type ${mimeType} received — this type is not supported yet]`);
    } catch (error) {
      log.error('Failed to process inbound attachment', {
        url: attachment.url.substring(0, 120),
        typeHint: attachment.type,
        error: error instanceof Error ? error.message : String(error),
      });
      noteLines.push('[Attachment received but it could not be processed]');
    }
  }

  log.info('Processed inbound attachments', {
    total: attachments.length,
    images: imageBlocks.length,
    notes: noteLines.length,
  });

  return { imageBlocks, noteLines };
}

async function downloadAttachment(
  attachment: SurgeAttachment
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const start = Date.now();
  const response = await fetch(attachment.url);
  if (!response.ok) {
    log.warn('Attachment download failed', {
      url: attachment.url.substring(0, 120),
      status: response.status,
    });
    return null;
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_ATTACHMENT_BYTES) {
    log.warn('Attachment exceeds size cap', {
      url: attachment.url.substring(0, 120),
      bytes: arrayBuffer.byteLength,
    });
    return null;
  }

  // The download response's Content-Type is authoritative; the webhook payload
  // hint is the fallback (some CDNs serve application/octet-stream).
  const headerType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
  const mimeType =
    headerType && headerType !== 'application/octet-stream'
      ? headerType
      : (attachment.type ?? (headerType || 'application/octet-stream'));

  log.info('Attachment downloaded', {
    url: attachment.url.substring(0, 120),
    mimeType,
    bytes: arrayBuffer.byteLength,
    durationMs: Date.now() - start,
  });

  return { buffer: Buffer.from(arrayBuffer), mimeType };
}

/** Transcribe a voice note via ElevenLabs Scribe (dedicated STT). */
async function transcribeVoiceNote(audio: Buffer, mimeType: string): Promise<string | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    log.warn('ELEVENLABS_API_KEY not set — cannot transcribe voice note');
    return null;
  }

  const start = Date.now();
  const form = new FormData();
  form.append('model_id', STT_MODEL);
  form.append(
    'file',
    new Blob([new Uint8Array(audio)], { type: mimeType }),
    `voice-note.${mimeType.split('/')[1] ?? 'audio'}`
  );

  const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
  });

  if (!response.ok) {
    const errorText = await response.text();
    log.error('Voice note transcription failed', {
      status: response.status,
      error: errorText.substring(0, 300),
    });
    return null;
  }

  const result = (await response.json()) as { text?: string };
  const transcript = result.text?.trim() ?? '';

  log.info('Voice note transcribed', {
    mimeType,
    audioBytes: audio.length,
    transcriptLength: transcript.length,
    transcriptPreview: transcript.substring(0, 100),
    durationMs: Date.now() - start,
  });

  return transcript || null;
}
