#!/usr/bin/env tsx
/**
 * Causal repro for phone FE playback: Vapi now stores recordings in a private
 * bucket. The poll payload's recordingUrl (often
 * *.r2.cloudflarestorage.com/hipaa-recordings/...) is not browser-playable.
 * Archive and FE playback must use the authenticated artifact API instead.
 */
import assert from 'node:assert/strict';

import { archiveVapiRecording } from '../../domains/vapi/archive';
import {
  firstPartyPhoneRecordingPath,
  rewriteEndedCallRecordingUrl,
} from '../../domains/vapi/recordings';

const PRIVATE_RECORDING_URL =
  'https://94bdb67bb98da30b06bdd917725c037d.r2.cloudflarestorage.com/hipaa-recordings/01a11772-75ae-7000-83c6-064e004a57af-mono.wav';
const CALL_ID = '01a11772-75ae-7000-83c6-064e004a57af';
const AGENT_ID = 'b31c8a09-5992-4916-b797-b9c3ae5c75cf';

async function main(): Promise<void> {
  const urls: string[] = [];
  const originalFetch = globalThis.fetch;
  process.env.VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY || 'test-vapi-private-key';

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const headers = new Headers(init?.headers);
    if (
      url.includes(`/call/${CALL_ID}/mono-recording`) &&
      headers.get('authorization')?.startsWith('Bearer ')
    ) {
      return new Response(Buffer.from('RIFF....WAVEfmt '), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      });
    }
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Error><Code>InvalidArgument</Code><Message>Authorization</Message></Error>',
      { status: 400, headers: { 'content-type': 'application/xml' } }
    );
  }) as typeof fetch;

  try {
    await archiveVapiRecording(AGENT_ID, CALL_ID, PRIVATE_RECORDING_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(
    urls.some((url) => url.includes(`/call/${CALL_ID}/mono-recording`)),
    `archive must download via authenticated Vapi artifact API, got: ${urls.join(', ') || '(no fetches)'}`
  );
  assert.ok(
    !urls.some(
      (url) => url.includes('r2.cloudflarestorage.com') || url.includes('hipaa-recordings')
    ),
    `archive must not fetch the private provider recordingUrl: ${urls.join(', ')}`
  );

  assert.equal(
    firstPartyPhoneRecordingPath(AGENT_ID, CALL_ID),
    `/api/agents/${AGENT_ID}/phone-calls/${CALL_ID}/recording`
  );
  const rewritten = rewriteEndedCallRecordingUrl(
    { status: 'ended', recordingUrl: PRIVATE_RECORDING_URL },
    CALL_ID,
    AGENT_ID
  );
  assert.equal(rewritten.recordingUrl, firstPartyPhoneRecordingPath(AGENT_ID, CALL_ID));
  const inProgress = rewriteEndedCallRecordingUrl(
    { status: 'in-progress', recordingUrl: PRIVATE_RECORDING_URL },
    CALL_ID,
    AGENT_ID
  );
  assert.equal(inProgress.recordingUrl, PRIVATE_RECORDING_URL);
}

void main();
