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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../../providers/rose';
import { TOOL_SCHEMAS } from '../../providers/smsSupervisor/supervisorTools.schemas';
import { resolveSendUserMessage } from '../../providers/smsSupervisor/messageGrounding';

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
  'block 3 requires a first-turn user response',
  SMS_SURFACE_OVERLAY.includes(
    'Respond to the user on your first turn, failing to respond quickly risks disengagement from the user.'
  ),
  'first-turn response rule missing from the SMS overlay'
);
// Tool-specific delivery mechanics belong to the tool description, where the
// model sees them at the decision boundary, rather than in the global surface
// prompt. The completion tool owns the other half of the send/stop contract.
const sendUserMessage = TOOL_SCHEMAS.find((tool) => tool.name === 'send_user_message');
const attemptCompletion = TOOL_SCHEMAS.find((tool) => tool.name === 'attempt_completion');
runCheck(
  'block 3 does not duplicate send_user_message delivery mechanics',
  !SMS_SURFACE_OVERLAY.includes('What send_user_message does:'),
  'tool-specific delivery mechanics leaked into the SMS overlay'
);
runCheck(
  'send_user_message tool owns immediate irreversible delivery',
  Boolean(
    sendUserMessage &&
    /real SMS/i.test(sendUserMessage.description) &&
    /immediately/i.test(sendUserMessage.description) &&
    /cannot be undone/i.test(sendUserMessage.description) &&
    /does not end the run/i.test(sendUserMessage.description)
  ),
  'send_user_message description is missing delivery mechanics'
);
runCheck(
  'attempt_completion tool owns the no-message completion contract',
  Boolean(
    attemptCompletion &&
    /sends no message/i.test(attemptCompletion.description) &&
    /successfully called send_user_message/i.test(attemptCompletion.description)
  ),
  'attempt_completion description is missing its send prerequisite'
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

// The overlay describes the runtime to the model, so a claim that stops being
// true silently becomes a lie the model acts on. Lifecycle SMS ARE replayed into
// the transcript verbatim now; the overlay previously told the model the opposite
// ("you cannot see their wording"), which is exactly the belief that makes it
// re-narrate progress the user was already told about — the duplicate-SMS bug.
runCheck(
  'block 3 does not claim lifecycle SMS wording is invisible',
  !/cannot see their wording/i.test(SMS_SURFACE_OVERLAY) &&
    !/only the underlying events/i.test(SMS_SURFACE_OVERLAY),
  'SMS overlay still claims the supervisor cannot see lifecycle SMS wording, but the runtime replays them verbatim'
);
runCheck(
  'block 3 tells the model lifecycle SMS already reached the phone',
  /You do see them/i.test(SMS_SURFACE_OVERLAY) &&
    /already read on the user's phone/i.test(SMS_SURFACE_OVERLAY),
  'SMS overlay is missing the already-delivered framing for lifecycle SMS'
);
runCheck(
  'block 3 counts the irreversible tools correctly',
  !/those four are not/i.test(SMS_SURFACE_OVERLAY) &&
    /those three are not/i.test(SMS_SURFACE_OVERLAY),
  'SMS overlay names three irreversible tools but miscounts them'
);

// web_search must resolve to the ONE fixture-aware implementation. A refactor
// that extracts a second, fixture-blind copy and re-points the dispatcher at it
// makes every web_search benchmark silently score a LIVE search: the closed-store
// task ordered from a restaurant whose closure it was never shown, and the run
// still reported a clean trajectory. Nothing else catches that.
const SUPERVISOR_DIR = join(__dirname, '..', '..', 'providers', 'smsSupervisor');
const TOOLS_SOURCE = readFileSync(join(SUPERVISOR_DIR, 'supervisorTools.ts'), 'utf8');
const WEB_SEARCH_SOURCE = readFileSync(
  join(SUPERVISOR_DIR, 'supervisorTools.webSearch.ts'),
  'utf8'
);
runCheck(
  'web_search dispatch uses the fixture-aware implementation',
  /import \{[^}]*executeWebSearchTool[^}]*\}\s*from\s*'\.\/supervisorTools\.webSearch'/s.test(
    TOOLS_SOURCE
  ),
  'supervisorTools.ts must import executeWebSearchTool from supervisorTools.webSearch (the only fixture-aware copy)'
);
runCheck(
  'the fixture-aware web_search honours the benchmark fixture file',
  WEB_SEARCH_SOURCE.includes('BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE') &&
    /benchmarkWebSearchFixture\(query\)/.test(WEB_SEARCH_SOURCE),
  'supervisorTools.webSearch must consult BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE before a live search'
);
runCheck(
  'no second web_search implementation exists to be wired in by mistake',
  !readFileSync(join(SUPERVISOR_DIR, 'supervisorTools.startAgent.ts'), 'utf8').includes(
    'executeWebSearchTool'
  ),
  'a duplicate executeWebSearchTool exists outside supervisorTools.webSearch'
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

// Missing information escalates to an agent instead of a questionnaire for
// the user (2026-10-07 eTA incident). Claim grounding is a prompt concern, not
// a harness regex: the regex guard rejected honest questions ("…email for the
// confirmation") eight times in a row and ended the run in the fallback apology.
runCheck(
  'block 3 escalates missing information instead of asking the user',
  SMS_SURFACE_OVERLAY.includes(
    "- If grep and web_search can't find information you need, escalate with start_new_agent instead of asking the user for it."
  ),
  'SMS overlay is missing the escalate-instead-of-ask rule'
);
runCheck(
  'send_user_message text is not classified by the harness',
  [
    'Placing your usual order now.',
    'Order submitted, confirmation #4421.',
    'Your email for the confirmation\n\nSend those.',
  ].every((message) => resolveSendUserMessage(message).ok) && !resolveSendUserMessage('   ').ok,
  'the harness still rejects send_user_message by its wording'
);

out(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  for (const f of failures) out(`  ${f}`);
  process.exit(1);
}
out('SMS prompt layering structural tests passed');
