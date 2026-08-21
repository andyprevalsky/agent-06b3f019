#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import type { CdpClient } from '../../domains/compute-grants/cdp';
import {
  finish,
  reapExpiredConnectSessions,
  releaseBrowser,
} from '../../domains/compute-grants/connectSession.lifecycle';
import { pending } from '../../domains/compute-grants/connectSession.state';
import { releaseAllConnectSessions } from '../../domains/compute-grants/connectSession.shutdown';
import type { PendingConnect } from '../../domains/compute-grants/connectSession.types';

function entry(
  connectId: string,
  options: {
    deadline?: number;
    finishedAt?: number;
    release?: (() => Promise<void>) | null;
    close?: () => void;
  } = {}
): PendingConnect {
  const cdp = { close: options.close ?? (() => undefined) } as unknown as CdpClient;
  return {
    connectId,
    userId: 'user-1',
    provider: 'claude',
    steelSessionId: 'browser-1',
    cdpBase: 'ws://browser',
    liveViewUrl: 'https://live.example',
    release: options.release ?? null,
    cdp,
    deadline: options.deadline ?? Date.now() + 60_000,
    stage: 'awaiting_human',
    done: false,
    ...(options.finishedAt === undefined ? {} : { finishedAt: options.finishedAt }),
  };
}

async function main(): Promise<void> {
  pending.clear();
  let closed = 0;
  let released = 0;
  const releasable = entry('release-once', {
    close: () => {
      closed += 1;
    },
    release: async () => {
      released += 1;
    },
  });
  await releaseBrowser(releasable);
  assert.equal(closed, 1);
  assert.equal(released, 1);
  assert.equal(releasable.release, null);
  assert.equal(releasable.cdp, null);
  assert.equal(typeof releasable.finishedAt, 'number');
  await releaseBrowser(releasable);
  assert.equal(released, 1, 'a browser release must be idempotent');

  const releaseFailure = entry('release-failure', {
    release: async () => {
      throw new Error('provider unavailable');
    },
  });
  await releaseBrowser(releaseFailure);
  assert.equal(releaseFailure.release, null);

  const finishSuccess = entry('finish-success', {
    release: async () => {
      released += 1;
    },
  });
  pending.set(finishSuccess.connectId, finishSuccess);
  await finish(finishSuccess);
  assert.equal(pending.has(finishSuccess.connectId), false);
  assert.equal(released, 2);

  const finishEmpty = entry('finish-empty');
  pending.set(finishEmpty.connectId, finishEmpty);
  await finish(finishEmpty);
  assert.equal(pending.has(finishEmpty.connectId), false);

  const finishFailure = entry('finish-failure', {
    release: async () => {
      throw 'release string failure';
    },
  });
  pending.set(finishFailure.connectId, finishFailure);
  await finish(finishFailure);
  assert.equal(pending.has(finishFailure.connectId), false);

  const now = Date.now();
  const expired = entry('expired', {
    deadline: now - 1,
    release: async () => {
      released += 1;
    },
  });
  const heldSuccess = entry('held-success', { finishedAt: now - 91_000 });
  const fresh = entry('fresh', { deadline: now + 10_000 });
  pending.set(expired.connectId, expired);
  pending.set(heldSuccess.connectId, heldSuccess);
  pending.set(fresh.connectId, fresh);
  assert.equal(await reapExpiredConnectSessions(now), 2);
  assert.equal(pending.has(fresh.connectId), true);
  assert.equal(await reapExpiredConnectSessions(now), 0);
  pending.clear();

  let shutdownCloses = 0;
  const shutdownSuccess = entry('shutdown-success', {
    close: () => {
      shutdownCloses += 1;
    },
    release: async () => undefined,
  });
  const shutdownFailure = entry('shutdown-failure', {
    close: () => {
      shutdownCloses += 1;
    },
    release: async () => {
      throw new Error('shutdown provider unavailable');
    },
  });
  const shutdownWithoutBrowser = entry('shutdown-empty', {
    close: () => {
      shutdownCloses += 1;
    },
  });
  pending.set(shutdownSuccess.connectId, shutdownSuccess);
  pending.set(shutdownFailure.connectId, shutdownFailure);
  pending.set(shutdownWithoutBrowser.connectId, shutdownWithoutBrowser);
  assert.equal(await releaseAllConnectSessions(), 1);
  assert.equal(shutdownCloses, 3);
  assert.equal(pending.size, 0);
  assert.equal(await releaseAllConnectSessions(), 0);
}

void main();
