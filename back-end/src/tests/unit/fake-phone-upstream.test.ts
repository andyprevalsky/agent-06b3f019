#!/usr/bin/env tsx
/**
 * The loopback Vapi/Twilio fake must serve both recording artifacts the downloader
 * requests (mono, then stereo) and must read Twilio's form-encoded REST bodies, so a
 * hang-up through hangUpTwilioCall completes the fake call (CodeRabbit PR #1865).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { VAPI_RECORDING_ARTIFACT_PATHS } from '../../providers/vapiRecordings';
import {
  respondFakePhoneUpstream,
  type FakePhoneUpstreamState,
} from '../../domains/vapi/fakePhoneUpstreamResponder';
import {
  BLACKBOX_FAKE_PHONE_UPSTREAM_PATH,
  createBlackboxFakePhoneUpstreamRouter,
} from '../../domains/vapi/routesBlackboxFakeUpstream';

function recordingArtifactsFollowCallState(): void {
  const state: FakePhoneUpstreamState = { vapiCalls: new Map(), twilioStatuses: new Map() };
  state.vapiCalls.set('ended-call', { id: 'ended-call', status: 'ended' } as never);
  state.vapiCalls.set('live-call', { id: 'live-call', status: 'in-progress' } as never);
  for (const artifact of VAPI_RECORDING_ARTIFACT_PATHS) {
    const [ended] = respondFakePhoneUpstream(state, {
      method: 'GET',
      path: `/call/ended-call/${artifact}`,
      body: '',
    });
    assert.equal(ended, 200, `${artifact} of an ended call`);
    const [live] = respondFakePhoneUpstream(state, {
      method: 'GET',
      path: `/call/live-call/${artifact}`,
      body: '',
    });
    assert.equal(live, 404, `${artifact} of a live call`);
  }
}

async function twilioFormHangUpCompletesTheCall(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(BLACKBOX_FAKE_PHONE_UPSTREAM_PATH, createBlackboxFakePhoneUpstreamRouter());
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${BLACKBOX_FAKE_PHONE_UPSTREAM_PATH}/2010-04-01/Accounts/ACfake`;
  const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
  try {
    const created = await fetch(`${base}/Calls.json`, {
      method: 'POST',
      headers: form,
      body: new URLSearchParams({ To: '+15550100', From: '+15550101' }),
    });
    assert.equal(created.status, 201);
    const { sid } = (await created.json()) as { sid: string };
    const hungUp = await fetch(`${base}/Calls/${sid}.json`, {
      method: 'POST',
      headers: form,
      body: new URLSearchParams({ Status: 'completed' }),
    });
    assert.equal(((await hungUp.json()) as { status: string }).status, 'completed');
    const read = await fetch(`${base}/Calls/${sid}.json`);
    assert.equal(((await read.json()) as { status: string }).status, 'completed');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function main(): Promise<void> {
  recordingArtifactsFollowCallState();
  await twilioFormHangUpCompletesTheCall();
  process.stdout.write('PASS fake phone upstream: stereo recording + Twilio form hang-up\n');
}

void main();
