#!/usr/bin/env tsx
/**
 * Structural test: the SMS supervisor system prompt reuses the main agent's
 * three-block skeleton (agents/utils/prompts.py:build_system_prompt):
 *
 *   Block 1  ROSE_CORE            — universal, user-agnostic (shared w/ main)
 *   Block 2  # User Context       — separate personal and delivery details
 *   Block 3  SMS_SURFACE_OVERLAY  — SMS-specific surface + response rules
 *
 * These assertions guard the cache contract (Block 1 must be byte-identical
 * across users so it is one fleet-wide ephemeral.global cache block) and the
 * layering (no per-user data in Block 1, no main-agent phase prose leaking into
 * the SMS prompt). Pure/DB-free: it calls the exported composition helpers
 * directly. The prose-drift pin lives in prompt-personality-sync.test.ts.
 */

import {
  ROSE_CORE,
  SMS_SURFACE_OVERLAY,
  assembleSystemPrompt,
  formatUserContext,
  type UserProfileContext,
} from '../../providers/smsSupervisor/contextBuilder';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../../providers/rose';

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function runCheck(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed++;
    out(`  PASS ${name}`);
  } else {
    failed++;
    failures.push(`${name}: ${detail}`);
    out(`  FAIL ${name} — ${detail}`);
  }
}

const userA: UserProfileContext = {
  userId: 'user-a',
  name: 'Ann Alpha',
  email: 'ann@example.com',
  phone: '+15550000001',
  deliveryRecipientName: 'Alex Recipient',
  addressLine1: '1 First St',
  addressLine2: 'Apt 2',
  city: 'New York',
  state: 'NY',
  postalCode: '10001',
  country: 'US',
  // Distinctive (not the default "Rose") so the leakage check below can't
  // collide with "Rose Labs Agent" in the shared core.
  systemName: 'Aria',
};

const userB: UserProfileContext = {
  userId: 'user-b',
  name: 'Bob Beta',
  email: 'bob@example.com',
  phone: '+15550000002',
  deliveryRecipientName: 'Bea Recipient',
  addressLine1: '99 Ninth Ave',
  addressLine2: null,
  city: 'Austin',
  state: 'TX',
  postalCode: '73301',
  country: 'US',
  systemName: 'Jarvis',
};

function blocksFor(user: UserProfileContext | null): string[] {
  const systemPrompt = assembleSystemPrompt({ userContextSection: formatUserContext(user) });
  return systemPrompt.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
}

out('── SMS supervisor three-block prompt layering ──');

const blocksA = blocksFor(userA);
const blocksB = blocksFor(userB);
const blocksNoUser = blocksFor(null);

// Layout: 3 blocks with a profile, 2 blocks without.
runCheck('three blocks when a user profile exists', blocksA.length === 3, `got ${blocksA.length}`);
runCheck(
  'two blocks when no user profile exists',
  blocksNoUser.length === 2,
  `got ${blocksNoUser.length}`
);

// Block 1 is exactly ROSE_CORE and identical across two different users.
runCheck(
  'block 1 is ROSE_CORE (user A)',
  blocksA[0] === ROSE_CORE,
  'block 1 drifted from ROSE_CORE'
);
runCheck(
  'block 1 byte-identical across two different users',
  blocksA[0] === blocksB[0],
  'block 1 varies per user — cache would not be shareable fleet-wide'
);
runCheck(
  'block 1 identical with and without a user profile',
  blocksA[0] === blocksNoUser[0],
  'ROSE_CORE must never depend on user presence'
);

// Block 1 carries no per-user data and no leftover placeholders.
const perUserTokens = [
  userA.name!,
  userB.name!,
  userA.phone!,
  userB.phone!,
  userA.systemName!,
  userB.systemName!,
  'Delivery Address',
  '{USER_NAME}',
  '{USER_ASSIGNED_ASSISTANT_NAME}',
];
for (const token of perUserTokens) {
  runCheck(
    `block 1 does not contain per-user token "${token}"`,
    !blocksA[0].includes(token) && !blocksB[0].includes(token),
    'per-user or placeholder text leaked into the shared core'
  );
}

// Block 2 is the per-user context; names live here, not in block 1.
runCheck(
  'block 2 is # User Context (user A)',
  blocksA[1].startsWith('# User Context'),
  blocksA[1].slice(0, 40)
);
runCheck(
  'block 2 separates personal identity from the delivery recipient',
  blocksA[1].includes('## Personal Information\nFull Name: Ann Alpha') &&
    blocksA[1].includes('Email: ann@example.com') &&
    blocksA[1].includes('## Delivery Address\nRecipient Name: Alex Recipient'),
  'personal identity or delivery recipient missing from block 2'
);
runCheck(
  'block 2 contains the per-user assistant name',
  blocksA[1].includes('Aria') && blocksB[1].includes('Jarvis'),
  'assistant name not surfaced in block 2'
);
runCheck(
  'block 2 renders the delivery address on separate lines',
  blocksA[1].includes('Recipient Name: Alex Recipient\n1 First St\nApt 2\nNew York, NY, 10001\nUS'),
  'delivery address format changed'
);

// Block 3 is the SMS overlay and is user-agnostic.
runCheck(
  'block 3 is SMS_SURFACE_OVERLAY (user A)',
  blocksA[2] === SMS_SURFACE_OVERLAY,
  'block 3 drifted'
);
runCheck(
  'block 3 byte-identical across two users',
  blocksA[2] === blocksB[2],
  'SMS overlay varies per user'
);
runCheck(
  'block 3 states the grep grounding contract',
  SMS_SURFACE_OVERLAY.includes('primarily through grep'),
  'grep grounding sentence missing from the SMS overlay'
);
runCheck(
  'block 3 separates send_user_message from attempt_completion',
  SMS_SURFACE_OVERLAY.includes('attempt_completion sends nothing') &&
    SMS_SURFACE_OVERLAY.includes('Sending a message does not end your run'),
  'SMS send/completion contract missing from the overlay'
);
runCheck(
  'block 3 states prior tool calls are erased from session history',
  SMS_SURFACE_OVERLAY.includes('Tool calls from previous runs') &&
    SMS_SURFACE_OVERLAY.includes('erased from this context to save space') &&
    SMS_SURFACE_OVERLAY.includes(
      'Do NOT assume a prior assistant turn was tool-free just because no tools appear beside it'
    ),
  'SMS session-history tool-erasure rule missing from the overlay'
);

// The SMS prompt must NOT contain main-agent phase/grader prose.
const fullPrompt = blocksA.join('\n');
for (const forbidden of [
  'PLAN phase',
  'EXECUTE phase',
  'How you are Graded',
  'attempt_completion, an automated',
]) {
  runCheck(
    `SMS prompt omits main-agent-only prose "${forbidden}"`,
    !fullPrompt.includes(forbidden),
    'main-agent phase/grader prose leaked into the SMS prompt'
  );
}

out(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  for (const f of failures) out(`  ${f}`);
  process.exit(1);
}
out('SMS prompt layering structural tests passed');
