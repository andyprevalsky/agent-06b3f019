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

import { archiveBytes } from '../traceArchive';
import { finishLlmCapture, startLlmCapture } from '../llmDump';
import { simpleArchiveOutput, userArchiveRoot } from '../llmArchiveRecord';
import { createHash } from 'node:crypto';
import { createLogger } from '../logger';
import type { ContentBlock } from '../rose';
import { processUploadedFile, type FilePointer } from '../storage';
import { downloadWhatsAppMedia } from '../whatsappCloud';

const log = createLogger('SmsInboundMedia');

/** Media attachment on an inbound Surge message (MMS photo, voice note, etc.). */
export interface SurgeAttachment {
  url: string;
  /** Content-type hint from the webhook payload (e.g. "image/jpeg"), if present. */
  type: string | null;
}

export interface WhatsAppMediaAttachment {
  mediaId: string;
  type: string | null;
}

export type InboundMediaAttachment = SurgeAttachment | WhatsAppMediaAttachment;

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // MMS media is small; 20MB is a generous cap
// scribe_v2 is the current batch STT model ($0.22/hr); scribe_v1 is removed
// 2026-07-09, and scribe_v2_realtime ($0.39/hr) only pays off for streaming.
const STT_MODEL = 'scribe_v2';

export interface ProcessedInboundMedia {
  /** One `image_url` content block per downloadable image attachment. */
  imageBlocks: ContentBlock[];
  /** Transcripts and status notes to append to the inbound message text. */
  noteLines: string[];
  /** Uploaded image FilePointers for start_new_agent create (same turn). */
  filePointers: FilePointer[];
}

/**
 * Download and classify all attachments on an inbound message.
 * Never throws — every attachment resolves to an image block or a note line.
 * Images are also uploaded so `start_new_agent` can attach FilePointers.
 */
export async function processInboundAttachments(
  attachments: InboundMediaAttachment[],
  userId: string
): Promise<ProcessedInboundMedia> {
  const imageBlocks: ContentBlock[] = [];
  const noteLines: string[] = [];
  const filePointers: FilePointer[] = [];

  for (const [index, attachment] of attachments.entries()) {
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
        // Same bytes the supervisor LLM already sees — upload once for create.
        try {
          const ext = mimeType.split('/')[1] ?? 'bin';
          filePointers.push(
            await processUploadedFile(userId, buffer, `sms-inbound-${index}.${ext}`, mimeType)
          );
        } catch (uploadError) {
          log.warn('Inbound image visible to supervisor but upload for agent attach failed', {
            url: 'url' in attachment ? attachment.url.substring(0, 120) : attachment.mediaId,
            error: uploadError instanceof Error ? uploadError.message : String(uploadError),
          });
        }
        continue;
      }

      if (mimeType.startsWith('audio/')) {
        const transcript = await transcribeVoiceNote(buffer, mimeType, userId);
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
        url: 'url' in attachment ? attachment.url.substring(0, 120) : attachment.mediaId,
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
    filePointers: filePointers.length,
  });

  return { imageBlocks, noteLines, filePointers };
}

async function downloadAttachment(
  attachment: InboundMediaAttachment
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  if ('mediaId' in attachment) {
    return downloadWhatsAppMedia(attachment.mediaId, MAX_ATTACHMENT_BYTES);
  }
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

/**
 * Transcribe a voice note via ElevenLabs Scribe (dedicated STT). The audio and
 * the transcript are archived under the user's SMS root (`user-<userId>`):
 *   media/stt/<sha256>.<ext>  +  llm/<dump_id> start / llm-updates final record
 */
async function transcribeVoiceNote(
  audio: Buffer,
  mimeType: string,
  userId: string
): Promise<string | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    log.warn('ELEVENLABS_API_KEY not set — cannot transcribe voice note');
    return null;
  }

  const start = Date.now();
  const rootAgentId = userArchiveRoot(userId);
  const audioPath = `media/stt/${createHash('sha256').update(audio).digest('hex')}.${
    mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'audio'
  }`;
  // createOnly: a failed write throws; null means the content-addressed object
  // already exists (or archiving is off, when no record is written either).
  const audioArchiveError = await archiveBytes({
    rootAgentId,
    objectPath: audioPath,
    body: audio,
    contentType: mimeType,
    compress: false,
    createOnly: true,
  }).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  );
  if (audioArchiveError !== null) {
    log.warn('Voice note audio archive failed; audio kept inline in the start record', {
      error: audioArchiveError,
    });
  }
  const capture = startLlmCapture({
    call_site: 'sms_voice_note_stt',
    agent_id: `sms-supervisor-${userId}`,
    root_agent_id: rootAgentId,
    model: STT_MODEL,
    message_count: 1,
    messages: [
      {
        role: 'user',
        // The start record (stored with its own retries) carries the audio
        // itself when the separate media/stt object was not confirmed.
        content: [
          audioArchiveError === null
            ? { type: 'input_audio', mime_type: mimeType, archive_path: audioPath }
            : {
                type: 'input_audio',
                mime_type: mimeType,
                data: audio.toString('base64'),
                archive_error: audioArchiveError,
              },
        ],
      },
    ],
    config: { provider: 'elevenlabs', model_id: STT_MODEL, audio_bytes: audio.length },
  });
  const finishFailed = (error: unknown, structured?: unknown): null => {
    finishLlmCapture(capture, {
      model: STT_MODEL,
      output: simpleArchiveOutput({
        content: '',
        actualModel: STT_MODEL,
        provider: 'elevenlabs',
        startedAtMs: start,
        ...(structured !== undefined ? { structured } : {}),
        error,
      }),
    });
    return null;
  };
  const form = new FormData();
  form.append('model_id', STT_MODEL);
  form.append(
    'file',
    new Blob([new Uint8Array(audio)], { type: mimeType }),
    `voice-note.${mimeType.split('/')[1] ?? 'audio'}`
  );

  let response: Response;
  try {
    response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
    });
  } catch (error) {
    finishFailed(error);
    throw error;
  }

  if (!response.ok) {
    let errorText: string;
    try {
      errorText = await response.text();
    } catch (error) {
      // The body read failed: still close the record with what is known.
      finishFailed(error, { status: response.status });
      throw error;
    }
    log.error('Voice note transcription failed', {
      status: response.status,
      error: errorText.substring(0, 300),
    });
    return finishFailed(new Error(`HTTP ${response.status}`), {
      status: response.status,
      body: errorText,
    });
  }

  let result: { text?: string };
  try {
    result = (await response.json()) as { text?: string };
  } catch (error) {
    finishFailed(error, { status: response.status });
    throw error;
  }
  const transcript = result.text?.trim() ?? '';
  finishLlmCapture(capture, {
    model: STT_MODEL,
    output: simpleArchiveOutput({
      content: transcript,
      actualModel: STT_MODEL,
      provider: 'elevenlabs',
      startedAtMs: start,
      structured: result,
    }),
  });

  log.info('Voice note transcribed', {
    mimeType,
    audioBytes: audio.length,
    transcriptLength: transcript.length,
    transcriptPreview: transcript.substring(0, 100),
    durationMs: Date.now() - start,
  });

  return transcript || null;
}
