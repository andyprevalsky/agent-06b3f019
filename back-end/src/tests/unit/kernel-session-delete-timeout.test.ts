#!/usr/bin/env tsx

import assert from 'node:assert';
import Kernel from '@onkernel/sdk';
import { KERNEL_SESSION_DELETE_TIMEOUT_MS } from '../../providers/browser/kernelSessionDelete';

// Kernel's single-browser endpoints took ~10.6s on 2026-10-26; a release budget
// below the SDK's own request default failed every attempt and leaked sessions.
assert.strictEqual(
  KERNEL_SESSION_DELETE_TIMEOUT_MS,
  Kernel.DEFAULT_TIMEOUT,
  'Kernel session delete must allow the Kernel SDK request budget'
);
