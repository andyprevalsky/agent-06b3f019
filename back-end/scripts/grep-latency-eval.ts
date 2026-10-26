#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Grep latency eval — a hill-climbing harness for the DB-backed Grep endpoint.
 *
 * It seeds a deterministic, *realistically sized* corpus (messages + contacts +
 * an agent tree), fires a fixed suite of LLM-shaped grep queries at the live
 * backend (`POST /api/data/grep`), and measures HTTP round-trip latency
 * percentiles per query. Each query targets a specific DB path so a single run
 * tells you which access pattern is slow:
 *
 *   - indexed literal      → should hit the pg_trgm GIN index (fast)
 *   - non-indexable class  → regex with no extractable trigram → seq scan
 *   - anchored regex       → seq scan
 *   - multiline            → seq scan + cross-line regex
 *   - agent_network        → tree walk + Message scan (no usable content index today)
 *   - deep pagination      → LIMIT offset+limit cost
 *   - all-sources          → three sources in parallel + count+search fan-out
 *
 * Output is a machine-readable JSON run file you can diff across code changes:
 *
 *   tsx scripts/grep-latency-eval.ts                 # seed + run + write report
 *   tsx scripts/grep-latency-eval.ts --no-seed       # reuse existing corpus
 *   tsx scripts/grep-latency-eval.ts --seed-only     # seed and exit
 *   tsx scripts/grep-latency-eval.ts --cleanup       # delete the corpus
 *   tsx scripts/grep-latency-eval.ts --scale 4       # 4x corpus volume
 *   tsx scripts/grep-latency-eval.ts --iterations 20
 *   tsx scripts/grep-latency-eval.ts compare A.json B.json   # delta two runs
 *
 * This is a benchmark, NOT a correctness test. Correctness lives in
 * data-grep.blackbox.ts. Here we only assert "same shape, faster".
 */

import { execSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { config } from 'dotenv';
import { prisma } from '../src/providers/database';

config();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || 'AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=';
const EVAL_USER_ID = process.env.GREP_EVAL_USER_ID || 'grep-latency-eval-user';
const FIXTURE_DOMAIN = 'grep-latency-eval.local';
const RUNS_DIR = join(__dirname, 'grep-eval-runs');
// Server-side statement_timeout caps queries at 10s; the client waits 11s as a
// backstop. Every case runs under the same bound — no opt-in, no gating.
const REQUEST_TIMEOUT_MS = 11_000;
const DB_STATEMENT_TIMEOUT_MS = 10_000;
// A grep query that takes longer than this is a failure regardless of the
// server-side cap value — used as the bounded-probe pass threshold.
const GREP_SLA_MS = 1_000;
// A case whose p95 exceeds this is flagged SLOW in the report.
const SLOW_THRESHOLD_MS = 250;
// Per-case wall-clock budget: stop iterating a genuinely slow case early so a
// handful of multi-second queries don't blow up total runtime.
const PER_CASE_BUDGET_MS = 20_000;
// Global budget: always write a (possibly partial) report rather than risk the
// whole run being killed by an external timeout with nothing to show.
const GLOBAL_BUDGET_MS = Number(process.env.GREP_EVAL_BUDGET_MS ?? 220_000);

interface EvalConfig {
  seed: boolean;
  seedOnly: boolean;
  cleanupOnly: boolean;
  iterations: number;
  warmup: number;
  scale: number;
  outPath: string | null;
  allowRemoteDb: boolean;
}

/**
 * Refuse to seed/cleanup against a non-local database. The eval writes ~thousands
 * of rows and runs deleteMany — pointing it at the prod pooler by accident would
 * be destructive. Override only with --allow-remote-db when you know the target
 * is a disposable benchmark DB.
 */
function assertLocalDatabase(allowRemote: boolean): void {
  const url = process.env.DATABASE_URL ?? '';
  const isLocal = /@(localhost|127\.0\.0\.1|host\.docker\.internal|postgres)[:/]/.test(url);
  if (isLocal || allowRemote) return;
  const host = url.replace(/^.*@/, '').split(/[:/]/)[0] || '(unset)';
  throw new Error(
    `Refusing to run against non-local DATABASE_URL (host: ${host}). ` +
      `This eval seeds thousands of rows and runs deleteMany. ` +
      `Point DATABASE_URL at your local Docker Postgres, or pass --allow-remote-db to override.`
  );
}

function parseArgs(argv: string[]): EvalConfig {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);
  return {
    seed: !has('--no-seed'),
    seedOnly: has('--seed-only'),
    cleanupOnly: has('--cleanup'),
    iterations: Number(get('--iterations') ?? 12),
    warmup: Number(get('--warmup') ?? 3),
    scale: Number(get('--scale') ?? 1),
    outPath: get('--out') ?? null,
    allowRemoteDb: has('--allow-remote-db'),
  };
}

// Volume — tuned so seq scans diverge visibly from index hits without taking
// forever to seed. Scale with --scale for stronger signal.
function volume(scale: number) {
  return {
    contactsWithMessages: Math.round(200 * scale),
    contactsOnly: Math.round(400 * scale),
    messagesPerContact: 25, // total messages ≈ 200*25*scale = 5000*scale
    agents: Math.round(40 * scale),
    agentMessages: Math.round(400 * scale),
  };
}

// ---------------------------------------------------------------------------
// Deterministic corpus generation (seeded PRNG → identical corpus every run)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMMON_WORDS = [
  'meeting',
  'project',
  'invoice',
  'budget',
  'schedule',
  'follow',
  'update',
  'review',
  'contract',
  'proposal',
  'deadline',
  'report',
  'design',
  'launch',
  'roadmap',
  'sync',
  'standup',
  'retro',
  'kickoff',
  'handoff',
  'forecast',
  'logistics',
  'onboarding',
  'pipeline',
  'rollout',
  'migration',
  'incident',
];
const FIRST_NAMES = [
  'Mara',
  'Theo',
  'Iris',
  'Cyrus',
  'Nadia',
  'Owen',
  'Lena',
  'Felix',
  'Vera',
  'Soren',
];
const LAST_NAMES = [
  'Voss',
  'Calder',
  'Ruiz',
  'Okafor',
  'Lindqvist',
  'Tan',
  'Mwangi',
  'Petrova',
  'Haas',
  'Sato',
];
const COMPANIES = [
  'Northstar Calibration Group',
  'Aperture Dynamics',
  'Helio Logistics',
  'Vantage Partners',
  'Cobalt Works',
];
const TITLES = [
  'Principal Signal Cartographer',
  'Head of Operations',
  'Staff Engineer',
  'Finance Owner',
  'Field Lead',
];

// A run of 'a' ending in a non-'a' char — the classic backtracking-bait shape.
// A long 'a' run ending in a non-'a' char — backtracking bait for the ReDoS
// probes. Postgres's NFA engine resists most of these, and the benchmark DB's
// 10s statement_timeout bounds the rest, so this is safe to seed at length.
const REDOS_BAIT = `${'a'.repeat(60)}X`;

const ADVERSARIAL_MESSAGES = [
  'Migrating the build to C++ next sprint',
  'Total budget is $100 for the offsite',
  'Released version a.b.c to staging today',
  'Call me at (415) 555-0199 tomorrow morning',
  'Tagged the doc [draft] for the review pass',
  'Quick maths: 2+2=4 confirmed by finance',
  'Lunch at café with résumé review 北京 launch 🚀 rocket',
  'The cat report and concatenate logs are ready',
  REDOS_BAIT,
];

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function sentence(rng: () => number, words: number): string {
  return Array.from({ length: words }, () => pick(rng, COMMON_WORDS)).join(' ');
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function chunkedCreate<T>(
  rows: T[],
  create: (chunk: T[]) => Promise<unknown>
): Promise<void> {
  const SIZE = 1000;
  for (let i = 0; i < rows.length; i += SIZE) {
    await create(rows.slice(i, i + SIZE));
  }
}

async function cleanup(): Promise<void> {
  await prisma.agent.deleteMany({ where: { userId: EVAL_USER_ID } });
  await prisma.person.deleteMany({ where: { userId: EVAL_USER_ID } });
  await prisma.user.deleteMany({ where: { userId: EVAL_USER_ID } });
}

interface SeedResult {
  rootAgentId: string;
  leafAgentId: string;
  counts: { contacts: number; messages: number; agents: number; agentMessages: number };
}

async function seed(scale: number): Promise<SeedResult> {
  const vol = volume(scale);
  const rng = mulberry32(0x9e3779b9);
  await cleanup();
  await prisma.user.create({ data: { userId: EVAL_USER_ID, isAnonymous: true } });

  // --- Contacts (network source) ---------------------------------------------
  // Most are noise; a few carry rare sentinels so literal-vs-class shows up.
  const totalContacts = vol.contactsWithMessages + vol.contactsOnly;
  const contactRows = Array.from({ length: totalContacts }, (_, i) => {
    const isSentinel = i === 7; // exactly one rare-title contact
    return {
      userId: EVAL_USER_ID,
      firstName: pick(rng, FIRST_NAMES),
      lastName: pick(rng, LAST_NAMES),
      email: `contact-${i}@${FIXTURE_DOMAIN}`,
      phoneNumber: `+1999${String(i).padStart(7, '0')}`,
      company: isSentinel ? 'Northstar Calibration Group' : pick(rng, COMPANIES),
      title: isSentinel ? 'Principal Signal Cartographer' : pick(rng, TITLES),
      relation: isSentinel ? 'benchmark verification contact' : 'colleague',
      communicationFrequency: isSentinel ? 'quarterly lighthouse cadence' : 'monthly',
      messagesExchanged: Math.floor(rng() * 500),
    };
  });
  await chunkedCreate(contactRows, (chunk) => prisma.person.createMany({ data: chunk }));

  const peopleWithMessages = await prisma.person.findMany({
    where: { userId: EVAL_USER_ID },
    select: { id: true },
    take: vol.contactsWithMessages,
    orderBy: { email: 'asc' },
  });

  // --- Messages (messages source) --------------------------------------------
  // Rare literal sentinel (1 row), broad common words (~every row), a numeric
  // class target, a multiline block, a mixed-case token, and a 30-row ledger.
  const messageRows: Array<{
    personId: string;
    userId: string;
    channel: 'EMAIL';
    from: string;
    to: string;
    timestamp: Date;
    message: string;
    externalId: string;
  }> = [];
  let msgSeq = 0;
  const baseTime = Date.UTC(2026, 0, 1);
  for (const person of peopleWithMessages) {
    for (let m = 0; m < vol.messagesPerContact; m++) {
      const idx = msgSeq++;
      let body = sentence(rng, 12);
      if (idx === 3)
        body = `Aurora budget: phase-17 approved\n${sentence(rng, 6)}`; // rare literal
      else if (idx % 50 === 0)
        body = `order ${100000 + idx} shipped on track\n${body}`; // numeric class target
      else if (idx % 73 === 0) {
        body = `Multiline incident START\nrequires cross-line search\nincident END\n${body}`; // multiline
      } else if (idx % 91 === 0) body = `MiXeDcAsE Beacon\n${body}`; // case-insensitive target
      messageRows.push({
        personId: person.id,
        userId: EVAL_USER_ID,
        channel: 'EMAIL',
        from: `${idx}@${FIXTURE_DOMAIN}`,
        to: `me@${FIXTURE_DOMAIN}`,
        timestamp: new Date(baseTime + idx * 60_000),
        message: body,
        externalId: `eval-msg-${idx}`,
      });
    }
  }
  // 30-entry pagination ledger on the first contact.
  const ledgerPerson = peopleWithMessages[0].id;
  for (let i = 0; i < 30; i++) {
    messageRows.push({
      personId: ledgerPerson,
      userId: EVAL_USER_ID,
      channel: 'EMAIL',
      from: `ledger@${FIXTURE_DOMAIN}`,
      to: `me@${FIXTURE_DOMAIN}`,
      timestamp: new Date(Date.UTC(2026, 5, 1) + i * 60_000),
      message: `Ledger entry ${i + 1}: ${i === 20 ? 'offset target confirmed' : 'ordinary ledger row'}`,
      externalId: `eval-ledger-${i + 1}`,
    });
  }
  // Adversarial rows: literal-metacharacter intent, unicode, and a
  // catastrophic-backtracking bait string (long 'a' run that fails an end
  // anchor). These give the regex-safety / escape / dialect probes real
  // targets to match (or to backtrack against).
  ADVERSARIAL_MESSAGES.forEach((message, i) => {
    messageRows.push({
      personId: ledgerPerson,
      userId: EVAL_USER_ID,
      channel: 'EMAIL',
      from: `adversarial@${FIXTURE_DOMAIN}`,
      to: `me@${FIXTURE_DOMAIN}`,
      timestamp: new Date(Date.UTC(2026, 6, 1) + i * 60_000),
      message,
      externalId: `eval-adv-${i}`,
    });
  });
  await chunkedCreate(messageRows, (chunk) => prisma.messageRecord.createMany({ data: chunk }));

  // --- Agent tree (agent_network source) -------------------------------------
  // A branching tree so the tree-walk + Message scan are exercised at volume.
  const root = await prisma.agent.create({
    data: { userId: EVAL_USER_ID, goal: 'grep eval root', status: 'COMPLETED', depth: 0 },
  });
  const agentIds = [root.id];
  for (let i = 1; i < vol.agents; i++) {
    const parent = agentIds[Math.floor(rng() * agentIds.length)];
    const agent = await prisma.agent.create({
      data: {
        userId: EVAL_USER_ID,
        goal: `grep eval agent ${i}: ${sentence(rng, 4)}`,
        status: 'COMPLETED',
        parentAgentId: parent,
        depth: 1 + Math.floor(rng() * 4),
      },
    });
    agentIds.push(agent.id);
  }

  const roles = ['USER', 'ASSISTANT', 'TOOL', 'SYSTEM'] as const;
  const agentMessageRows = Array.from({ length: vol.agentMessages }, (_, i) => {
    const role = roles[i % roles.length];
    let text = sentence(rng, 14);
    if (i === 5)
      text = `Atlas handoff was confirmed by the user. ${text}`; // rare literal
    else if (i % 40 === 0) text = `tool exit code 0 batch ${200000 + i} complete\n${text}`; // numeric class
    return {
      agentId: pick(rng, agentIds),
      role,
      text,
      metadata: role === 'TOOL' ? { eval: 'grep', toolStatus: 'FINISHED' } : { eval: 'grep' },
      createdAt: new Date(baseTime + i * 30_000),
    };
  });
  // Adversarial agent-tree rows so the safety/escape probes also exercise the
  // agent_network path (tree walk + concat_ws scan), not just messages.
  agentMessageRows.push(
    {
      agentId: agentIds[0],
      role: 'TOOL',
      text: `tool output: ${REDOS_BAIT}`,
      metadata: { eval: 'grep', toolStatus: 'FINISHED' },
      createdAt: new Date(baseTime + vol.agentMessages * 30_000),
    },
    {
      agentId: agentIds[0],
      role: 'ASSISTANT',
      text: 'Migrating the agent build to C++ and shipping résumé review 🚀',
      metadata: { eval: 'grep' },
      createdAt: new Date(baseTime + (vol.agentMessages + 1) * 30_000),
    }
  );
  await chunkedCreate(agentMessageRows, (chunk) => prisma.message.createMany({ data: chunk }));

  return {
    rootAgentId: root.id,
    leafAgentId: agentIds[agentIds.length - 1],
    counts: {
      contacts: totalContacts,
      messages: messageRows.length,
      agents: agentIds.length,
      agentMessages: agentMessageRows.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Query suite — each query stresses one DB access path
// ---------------------------------------------------------------------------

type Expect = 'ok' | 'invalid' | 'bounded' | 'observe';
type Source = 'messages' | 'network' | 'agent_network' | undefined;

interface QuerySpec {
  name: string;
  category: string;
  note: string;
  coverage: string[];
  body: Record<string, unknown>;
  /** Whether agent_id must be injected (agent_network or omitted-source). */
  needsAgent: boolean;
  /**
   * Outcome class:
   *  - ok:       expect HTTP 200; time it.
   *  - invalid:  expect HTTP 400 (regex rejected at validation).
   *  - bounded:  expect 200 AND max latency <= maxMs (regex-safety probe).
   *  - observe:  record whatever status comes back (dialect divergence probe).
   */
  expect: Expect;
  maxMs?: number;
  iterations?: number;
  warmup?: number;
  timeoutMs?: number;
}

// Upper bound on suite size. Set above the number of generated cases so the
// realistic-edge-case group (appended last) is never sliced off.
const TARGET_SUITE_SIZE = 400;

function srcTag(s: Source): string {
  return s ?? 'all';
}

function sourceNeedsAgent(s: Source): boolean {
  return s === 'agent_network' || s === undefined;
}

function mkBody(
  pattern: string,
  source: Source,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    pattern,
    ...(source ? { source } : {}),
    head_limit: 20,
    ...extra,
  };
}

/**
 * Build ~200 coverage-tagged grep cases across four outcome classes and the
 * full regex feature space. Critical safety/correctness groups are pushed
 * first so they survive the slice to TARGET_SUITE_SIZE; the bulk latency
 * sweeps form the trimmable tail.
 */
function buildSuite(): QuerySpec[] {
  const specs: QuerySpec[] = [];
  const add = (s: Omit<QuerySpec, 'name' | 'needsAgent'> & { needsAgent?: boolean }): void => {
    const idx = String(specs.length + 1).padStart(3, '0');
    specs.push({
      note: '',
      ...s,
      needsAgent: s.needsAgent ?? sourceNeedsAgent(s.body.source as Source),
      name: `${idx}_${s.category}_${srcTag(s.body.source as Source)}`,
    });
  };

  // ===== CRITICAL GROUPS (never trimmed) ===================================

  // G1. Nested-quantifier / backtracking-shaped patterns. Every one runs — no
  // gating. The server-side statement_timeout (10s) bounds anything pathological;
  // a probe "passes" if it returns before that cap, and is flagged SLOW/UNBOUNDED
  // if it hits it. This is both a DoS check and a regression guard.
  const REDOS = [
    '(a+)+$',
    '(\\w+\\s?)+$',
    '(ab)+c',
    '(\\d+)+x',
    '([a-z]+)*$',
    '(.*a){20}$',
    '(a|a)*$',
    '(.*,){20}$',
  ];
  for (const source of ['messages', 'network', 'agent_network'] as Source[]) {
    for (const pattern of REDOS) {
      add({
        category: 'safety_redos',
        note: 'Backtracking-shaped probe — must return before the query timeout',
        coverage: ['safety:redos', 'regex:nested-quantifier', `source:${srcTag(source)}`],
        body: mkBody(pattern, source),
        expect: 'bounded',
        // A grep should return well under 1s. Slower = failure, cap-independent:
        // these patterns blow past the SLA whether the server cap is 3s or 10s.
        maxMs: GREP_SLA_MS,
        iterations: 1,
        warmup: 0,
      });
    }
  }

  // G2. Regex-dialect divergence — JS validates (RegExp), Postgres executes
  // (POSIX ARE). Patterns that disagree expose the validate-vs-execute seam.
  const DIALECT = [
    '(?<=Aurora )budget', // lookbehind: JS ok, ARE unsupported
    'budget(?= )', // lookahead
    '(?<grp>phase)-17', // named group
    '[[:digit:]]{3,}', // POSIX class
    '(\\w+) \\1', // backreference
    'phase\\d+', // \d shorthand
    '\\bAtlas\\b', // word boundary
    '(?i)budget', // inline flag
    'a++', // possessive quantifier
  ];
  for (const source of ['messages', 'agent_network'] as Source[]) {
    for (const pattern of DIALECT) {
      add({
        category: 'dialect',
        note: 'Dialect divergence — record status to find validate/execute mismatches',
        coverage: ['safety:dialect', `source:${srcTag(source)}`],
        body: mkBody(pattern, source),
        expect: 'observe',
        iterations: 1,
        warmup: 0,
      });
    }
  }

  // G3. Invalid regex — must be rejected at validation with HTTP 400.
  const INVALID = [
    '[',
    '(',
    '*abc',
    '+lead',
    'a{2,1}',
    '\\',
    '[a-',
    '(?P<n>x',
    'C++',
    'a**',
    '(unclosed',
    'no)group',
  ];
  for (const pattern of INVALID) {
    add({
      category: 'invalid',
      note: 'Malformed regex — expect HTTP 400 INVALID_PATTERN',
      coverage: ['safety:invalid-regex'],
      body: mkBody(pattern, 'messages'),
      expect: 'invalid',
      iterations: 3,
      warmup: 0,
    });
  }

  // G4. Literal-metacharacter intent — escaped forms that should match the
  // adversarial rows; the raw forms that happen to stay valid over-match.
  const ESCAPED: Array<[string, Source]> = [
    ['C\\+\\+', 'messages'],
    ['C\\+\\+', 'agent_network'],
    ['\\$100', 'messages'],
    ['a\\.b\\.c', 'messages'],
    ['\\(415\\) 555', 'messages'],
    ['\\[draft\\]', 'messages'],
    ['2\\+2=4', 'messages'],
    ['a.b.c', 'messages'], // raw dots over-match but valid
    ['budget.*\\$', 'messages'],
  ];
  for (const [pattern, source] of ESCAPED) {
    add({
      category: 'literal_metachar',
      note: 'Escaped metacharacters — literal search intent',
      coverage: ['regex:escape', `source:${srcTag(source)}`],
      body: mkBody(pattern, source),
      expect: 'ok',
    });
  }

  // G5. Escapes, unicode, and word boundaries.
  const SPECIAL: Array<[string, Source]> = [
    ['\\bcat\\b', 'messages'],
    ['concatenate', 'messages'],
    ['café', 'messages'],
    ['résumé', 'messages'],
    ['北京', 'messages'],
    ['🚀', 'messages'],
    ['🚀', 'agent_network'],
    ['\\bhandoff\\b', 'agent_network'],
    ['café', 'agent_network'],
  ];
  for (const [pattern, source] of SPECIAL) {
    add({
      category: 'unicode_boundary',
      note: 'Unicode / word-boundary / escaped search',
      coverage: ['regex:unicode', 'regex:word-boundary', `source:${srcTag(source)}`],
      body: mkBody(pattern, source),
      expect: 'ok',
    });
  }

  // ===== BULK LATENCY SWEEPS (trimmable tail) ==============================

  // G6. Literal selectivity × source (selective / broad / no-match).
  const BROAD = ['meeting', 'project', 'budget', 'update', 'report', 'invoice', 'incident'];
  for (const source of ['messages', 'network', 'agent_network', undefined] as Source[]) {
    add({
      category: 'literal_selective',
      note: 'Highly selective literal — index floor',
      coverage: ['regex:literal', 'select:high', `source:${srcTag(source)}`],
      body: mkBody('Aurora budget', source),
      expect: 'ok',
    });
    for (const pattern of BROAD) {
      add({
        category: 'literal_broad',
        note: 'Broad literal — index + large result/count',
        coverage: ['regex:literal', 'select:broad', `source:${srcTag(source)}`],
        body: mkBody(pattern, source),
        expect: 'ok',
      });
    }
    add({
      category: 'literal_nomatch',
      note: 'Literal with zero matches',
      coverage: ['regex:literal', 'select:none', `source:${srcTag(source)}`],
      body: mkBody('qzx-absent-token', source),
      expect: 'ok',
    });
  }

  // G7. Character classes & quantifiers × source.
  const CLASSES = [
    '[0-9]{4,}',
    '[0-9]{6,}',
    '[a-z]+ing',
    '\\w{8,}',
    '.{20,}',
    '[A-Z][a-z]+',
    '[0-9]+',
    'col[ou]r',
    '[aeiou]{3}',
  ];
  for (const source of ['messages', 'network', 'agent_network'] as Source[]) {
    for (const pattern of CLASSES) {
      add({
        category: 'class_quantifier',
        note: 'Character class / quantifier — usually non-indexable',
        coverage: ['regex:class', 'regex:quantifier', `source:${srcTag(source)}`],
        body: mkBody(pattern, source),
        expect: 'ok',
      });
    }
  }

  // G8. Anchors × source.
  const ANCHORS = ['^Ledger', '^Multiline', 'entry$', 'approved$', '^[A-Z]', 'END$'];
  for (const source of ['messages', 'agent_network'] as Source[]) {
    for (const pattern of ANCHORS) {
      add({
        category: 'anchor',
        note: 'Anchored regex',
        coverage: ['regex:anchor', `source:${srcTag(source)}`],
        body: mkBody(pattern, source),
        expect: 'ok',
      });
    }
  }

  // G9. Alternation × source.
  const ALTERNATION = [
    '(meeting|call|sync)',
    '(budget|invoice|cost)',
    '(project|proposal|plan)',
    '(START|END)',
    '(Atlas|Aurora)',
  ];
  for (const source of ['messages', 'agent_network', undefined] as Source[]) {
    for (const pattern of ALTERNATION) {
      add({
        category: 'alternation',
        note: 'Alternation group',
        coverage: ['regex:alternation', `source:${srcTag(source)}`],
        body: mkBody(pattern, source),
        expect: 'ok',
      });
    }
  }

  // G10. Case-insensitive (`-i`).
  const CI = ['MEETING', 'Budget', 'ATLAS HANDOFF', 'aurora', 'incident'];
  for (const source of ['messages', 'agent_network'] as Source[]) {
    for (const pattern of CI) {
      add({
        category: 'case_insensitive',
        note: 'Case-insensitive (~* path)',
        coverage: ['flag:-i', `source:${srcTag(source)}`],
        body: mkBody(pattern, source, { '-i': true }),
        expect: 'ok',
      });
    }
  }

  // G11. Multiline.
  const MULTILINE = ['START.*END', 'incident.*search', 'Aurora.*approved'];
  for (const pattern of MULTILINE) {
    add({
      category: 'multiline',
      note: 'Cross-line regex',
      coverage: ['flag:multiline', 'source:messages'],
      body: mkBody(pattern, 'messages', { multiline: true }),
      expect: 'ok',
    });
  }
  add({
    category: 'multiline',
    note: 'Cross-line regex over agent tree',
    coverage: ['flag:multiline', 'source:agent_network'],
    body: mkBody('handoff.*confirmed', 'agent_network', { multiline: true }),
    expect: 'ok',
  });

  // G12. Context flags (-A / -B / -C / context, with -n).
  const CONTEXT: Array<Record<string, unknown>> = [
    { '-A': 2 },
    { '-B': 2 },
    { '-C': 2 },
    { context: 3 },
    { '-A': 3, '-B': 1 },
    { '-A': 2, '-n': false },
    { '-C': 5, '-n': false },
  ];
  for (const extra of CONTEXT) {
    add({
      category: 'context',
      note: 'Context lines + line-number flag',
      coverage: ['flag:context', ...Object.keys(extra).map((k) => `flag:${k}`), 'source:messages'],
      body: mkBody('Aurora budget', 'messages', extra),
      expect: 'ok',
    });
  }
  add({
    category: 'context',
    note: 'Context lines over agent tree',
    coverage: ['flag:context', 'source:agent_network'],
    body: mkBody('Atlas handoff', 'agent_network', { '-C': 3 }),
    expect: 'ok',
  });

  // G13. Pagination sweep (head_limit / offset).
  const PAGES: Array<[number, number]> = [
    [5, 0],
    [5, 5],
    [5, 20],
    [10, 10],
    [20, 0],
    [1, 25],
    [50, 0],
    [5, 40],
  ];
  for (const [head_limit, offset] of PAGES) {
    add({
      category: 'pagination',
      note: `head_limit=${head_limit} offset=${offset}`,
      coverage: ['flag:head_limit', 'flag:offset', 'source:messages'],
      body: mkBody('Ledger entry', 'messages', { head_limit, offset }),
      expect: 'ok',
    });
  }

  // G14. Short sub-trigram patterns (cannot use the trgm index).
  const SHORT = ['ok', 'hi', 'no', 'to', 'at', '42'];
  for (const pattern of SHORT) {
    add({
      category: 'short',
      note: 'Sub-trigram pattern — index cannot apply',
      coverage: ['regex:short', 'source:messages'],
      body: mkBody(pattern, 'messages'),
      expect: 'ok',
    });
  }

  // G15. Flag combinatorics.
  const COMBOS: Array<Record<string, unknown>> = [
    { '-i': true, multiline: true },
    { '-i': true, '-C': 2 },
    { multiline: true, '-A': 2 },
    { '-i': true, head_limit: 5, offset: 5 },
    { '-i': true, '-n': false, '-C': 1 },
  ];
  for (const extra of COMBOS) {
    add({
      category: 'flag_combo',
      note: 'Multiple flags together',
      coverage: ['flag:combo', ...Object.keys(extra).map((k) => `flag:${k}`), 'source:messages'],
      body: mkBody('budget', 'messages', extra),
      expect: 'ok',
    });
  }

  // G16. Realistic LLM-emitted phrase greps.
  const PHRASES = [
    'follow up',
    'meeting notes',
    'project update',
    'invoice paid',
    'quarterly report',
    'next steps',
    'action items',
    'budget approval',
    'kickoff call',
    'status update',
    'deadline reminder',
    'launch plan',
  ];
  for (const source of ['messages', undefined] as Source[]) {
    for (const pattern of PHRASES) {
      add({
        category: 'realistic_phrase',
        note: 'Realistic multi-word agent query',
        coverage: ['regex:phrase', `source:${srcTag(source)}`],
        body: mkBody(pattern, source),
        expect: 'ok',
      });
    }
  }

  // G17. Realistic regex shapes the model genuinely emits — money, dates,
  // versions, emails, phones, invoices, URLs, handles, wildcards. All are
  // degree ≤ 2 (verified safe), so they MUST pass the ReDoS guard. This group
  // measures the guard's false-positive rate: every one should return 200.
  const REALISTIC_EDGE = [
    '\\$[0-9,]+(\\.[0-9]{2})?', // money: $1,200.00
    '\\b[0-9]{4}-[0-9]{2}-[0-9]{2}\\b', // ISO date
    '\\bQ[1-4]\\s+20[0-9]{2}\\b', // quarter: Q3 2026
    'v[0-9]+\\.[0-9]+\\.[0-9]+', // semver: v1.2.3
    '[\\w.]+@[\\w.]+', // email-ish
    '\\(?[0-9]{3}\\)?[-.\\s][0-9]{3}[-.\\s][0-9]{4}', // phone
    '(invoice|receipt|order)\\s+#?[0-9]+', // invoice ref
    'INV-[0-9]{4,}', // invoice id
    '(?:re|fwd):\\s', // email subject prefix
    'meeting.*tomorrow', // wildcard phrase (deg 2)
    'dinner.*reservation',
    'project.*deadline',
    'https?://[\\w./-]+', // url
    '@[a-zA-Z0-9_]+', // handle
    '#[a-zA-Z0-9_]+', // hashtag
    '[0-9]{1,2}:[0-9]{2}\\s*(am|pm)?', // time
    '[0-9]+(\\.[0-9]+)?%', // percent
    '\\b(yes|no|maybe)\\b', // word alternation
    '[A-Z]{2,4}-[0-9]{2,5}', // ticket: ABC-1234
    '[a-z_]+\\([^)]*\\)', // function call (deg 2)
    'follow[-\\s]?up', // follow-up variants
    '[A-Z][a-z]+\\s+[A-Z][a-z]+', // First Last
    '(urgent|asap|important)',
    '\\bphase-[0-9]+\\b',
  ];
  for (const source of ['messages', undefined] as Source[]) {
    for (const pattern of REALISTIC_EDGE) {
      add({
        category: 'realistic_edge',
        note: 'Realistic regex the model emits — must pass the ReDoS guard',
        coverage: ['regex:realistic-edge', 'safety:no-false-positive', `source:${srcTag(source)}`],
        body: mkBody(pattern, source),
        expect: 'ok',
      });
    }
  }

  return specs.slice(0, TARGET_SUITE_SIZE);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface QueryStats {
  name: string;
  category: string;
  note: string;
  coverage: string[];
  expect: Expect;
  pattern: string;
  status: number;
  statusDistribution: Record<string, number>;
  totalMatches: number | null;
  returnedMatches: number | null;
  samples: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  stdev: number;
  errors: number;
  /** For expect='bounded': true if every sample stayed within maxMs. null otherwise. */
  safetyPass: boolean | null;
  maxMs: number | null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

async function callGrep(
  body: Record<string, unknown>,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<{ status: number; ms: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  try {
    const response = await fetch(`${BASE_URL}/api/data/grep`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
        'X-User-Id': EVAL_USER_ID,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const ms = performance.now() - start;
    const data = await response.json().catch(() => null);
    return { status: response.status, ms, data };
  } catch (error) {
    const ms = performance.now() - start;
    return { status: controller.signal.aborted ? 408 : 0, ms, data: { error: String(error) } };
  } finally {
    clearTimeout(timer);
  }
}

async function runQuery(spec: QuerySpec, cfg: EvalConfig, agentId: string): Promise<QueryStats> {
  const body = { ...spec.body, ...(spec.needsAgent ? { agent_id: agentId } : {}) };
  // ok/bounded → 200; invalid → 400; observe → record whatever comes back.
  // bounded probes also record any status: a fast statement_timeout 500 still
  // proves the request is *bounded*, which is the safety property we want.
  const expectStatus = spec.expect === 'invalid' ? 400 : 200;
  const recordAnyStatus = spec.expect === 'observe' || spec.expect === 'bounded';
  const iterations = spec.iterations ?? cfg.iterations;
  const warmup = spec.warmup ?? cfg.warmup;
  const timeoutMs = spec.timeoutMs ?? REQUEST_TIMEOUT_MS;

  for (let i = 0; i < warmup; i++) await callGrep(body, timeoutMs);

  const samples: number[] = [];
  const statusDistribution: Record<string, number> = {};
  let errors = 0;
  let status = expectStatus;
  let totalMatches: number | null = null;
  let returnedMatches: number | null = null;

  const caseStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    // Per-case budget: once we've spent enough wall-clock and have ≥1 sample,
    // stop — a multi-second case doesn't need 10 reps to be flagged slow.
    if (i > 0 && performance.now() - caseStart > PER_CASE_BUDGET_MS) break;
    const res = await callGrep(body, timeoutMs);
    status = res.status;
    statusDistribution[String(res.status)] = (statusDistribution[String(res.status)] ?? 0) + 1;

    const accepted = recordAnyStatus || res.status === expectStatus;
    if (!accepted) {
      errors++;
      continue;
    }
    // Time only successful (200) responses; a 400/observe still records status.
    if (res.status === 200) {
      samples.push(res.ms);
      if (totalMatches === null && res.data && typeof res.data === 'object') {
        const d = res.data as { total_matches?: number; matches?: unknown[] };
        totalMatches = d.total_matches ?? null;
        returnedMatches = Array.isArray(d.matches) ? d.matches.length : null;
      }
    } else if (recordAnyStatus) {
      // observe probe that didn't 200 — still capture its latency
      samples.push(res.ms);
    }
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / (samples.length || 1);
  const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / (samples.length || 1);
  const max = round(sorted[sorted.length - 1] ?? 0);

  // Safety verdict for bounded probes: every sample within maxMs, no timeouts.
  let safetyPass: boolean | null = null;
  if (spec.expect === 'bounded') {
    const timedOut = (statusDistribution['408'] ?? 0) > 0 || (statusDistribution['0'] ?? 0) > 0;
    safetyPass = !timedOut && samples.length > 0 && max <= (spec.maxMs ?? Infinity);
  }

  return {
    name: spec.name,
    category: spec.category,
    note: spec.note,
    coverage: spec.coverage,
    expect: spec.expect,
    pattern: String(spec.body.pattern ?? ''),
    status,
    statusDistribution,
    totalMatches,
    returnedMatches,
    samples: samples.length,
    min: round(sorted[0] ?? 0),
    p50: round(percentile(sorted, 50)),
    p90: round(percentile(sorted, 90)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max,
    mean: round(mean),
    stdev: round(Math.sqrt(variance)),
    errors,
    safetyPass,
    maxMs: spec.maxMs ?? null,
  };
}

/**
 * Confirm the benchmark DB has a statement_timeout, which (a) bounds pathological
 * regex server-side so the eval can't wedge the backend, and (b) is the exact
 * production fix recommended for the missing-timeout finding. Without it the
 * ReDoS probes can pin Postgres. Warn loudly if it's unset.
 */
async function checkStatementTimeout(): Promise<void> {
  try {
    const rows = await prisma.$queryRaw<Array<{ statement_timeout: string }>>`
      SELECT current_setting('statement_timeout') AS statement_timeout
    `;
    const value = rows[0]?.statement_timeout ?? '0';
    if (value === '0' || value === '') {
      console.warn(
        '⚠️  No statement_timeout on the benchmark DB. Pathological regex probes ' +
          'can hang Postgres. Set one with:\n' +
          "    ALTER DATABASE <db> SET statement_timeout='2000ms';  (then restart the backend)"
      );
    } else {
      console.log(`statement_timeout = ${value}`);
    }
  } catch {
    /* best-effort */
  }
}

async function checkBackend(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/api/data/grep`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
        'X-User-Id': EVAL_USER_ID,
      },
      body: JSON.stringify({ pattern: 'healthcheck', source: 'messages', head_limit: 1 }),
    });
    if (res.status >= 500) throw new Error(`backend returned ${res.status}`);
  } catch (error) {
    throw new Error(
      `Backend not reachable at ${BASE_URL} (${String(error)}). Start it with: cd back-end && npm run dev`
    );
  }
}

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
  } catch {
    return 'unknown';
  }
}

function isoNow(): string {
  // new Date() is fine here — this is a benchmark script, not a Temporal workflow.
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const padL = (s: string | number, n: number) => String(s).padStart(n);

/** Top-N slowest timed queries (ok/bounded with samples). */
function printLatencyTable(results: QueryStats[], topN: number): void {
  const timed = results
    .filter((r) => r.samples > 0 && (r.expect === 'ok' || r.expect === 'bounded'))
    .sort((a, b) => b.p50 - a.p50);
  console.log(`\n── Top ${topN} slowest (of ${timed.length} timed queries) ──`);
  console.log(
    `${pad('query', 34)} ${pad('category', 17)} ${padL('p50', 7)} ${padL('p95', 8)} ${padL('max', 9)} ${padL('matches', 9)} ${padL('err', 4)}`
  );
  console.log('-'.repeat(94));
  for (const r of timed.slice(0, topN)) {
    console.log(
      `${pad(r.name, 34)} ${pad(r.category, 17)} ${padL(r.p50, 7)} ${padL(r.p95, 8)} ${padL(r.max, 9)} ${padL(r.totalMatches ?? '-', 9)} ${padL(r.errors, 4)}`
    );
  }
}

/** Per-coverage-tag case counts — proves the suite spans the feature space. */
function coverageMatrix(results: QueryStats[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results) for (const tag of r.coverage) out[tag] = (out[tag] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => a[0].localeCompare(b[0])));
}

function categoryRollup(results: QueryStats[]): Record<string, number> {
  const byCat: Record<string, number[]> = {};
  for (const r of results) if (r.samples > 0) (byCat[r.category] ??= []).push(r.p50);
  const out: Record<string, number> = {};
  for (const [cat, vals] of Object.entries(byCat)) {
    out[cat] = round(vals.reduce((s, v) => s + v, 0) / vals.length);
  }
  return out;
}

interface SafetySummary {
  redos: { total: number; passed: number; failures: QueryStats[] };
  invalid: { total: number; passed: number; failures: QueryStats[] };
  dialect: { total: number; statusBreakdown: Record<string, number>; nonOk: QueryStats[] };
}

function safetySummary(results: QueryStats[]): SafetySummary {
  const redosProbes = results.filter((r) => r.expect === 'bounded');
  const invalidProbes = results.filter((r) => r.expect === 'invalid');
  const dialectProbes = results.filter((r) => r.expect === 'observe');

  const statusBreakdown: Record<string, number> = {};
  for (const r of dialectProbes)
    for (const [code, count] of Object.entries(r.statusDistribution))
      statusBreakdown[code] = (statusBreakdown[code] ?? 0) + count;

  return {
    redos: {
      total: redosProbes.length,
      passed: redosProbes.filter((r) => r.safetyPass === true).length,
      failures: redosProbes.filter((r) => r.safetyPass !== true),
    },
    invalid: {
      total: invalidProbes.length,
      passed: invalidProbes.filter((r) => r.errors === 0).length,
      failures: invalidProbes.filter((r) => r.errors > 0),
    },
    dialect: {
      total: dialectProbes.length,
      statusBreakdown,
      nonOk: dialectProbes.filter((r) =>
        Object.keys(r.statusDistribution).some((c) => c !== '200')
      ),
    },
  };
}

function printSafety(s: SafetySummary): void {
  console.log('\n── Regex safety & correctness ──');
  console.log(
    `ReDoS / backtracking probes: ${s.redos.passed}/${s.redos.total} bounded` +
      (s.redos.failures.length ? '  ⚠️  UNBOUNDED:' : ' ✓')
  );
  for (const r of s.redos.failures.slice(0, 12)) {
    const reason = r.safetyPass === null ? 'no data' : `max ${r.max}ms > ${r.maxMs}ms / timeout`;
    console.log(`   ✗ ${pad(r.pattern, 22)} [${r.category.replace('safety_', '')}] ${reason}`);
  }
  console.log(
    `Invalid-regex rejection (400): ${s.invalid.passed}/${s.invalid.total} correct` +
      (s.invalid.failures.length ? '  ⚠️  NOT REJECTED:' : ' ✓')
  );
  for (const r of s.invalid.failures.slice(0, 12)) {
    console.log(`   ✗ ${pad(r.pattern, 22)} got ${JSON.stringify(r.statusDistribution)}`);
  }
  console.log(
    `Dialect-divergence probes: ${s.dialect.total} observed — status mix ${JSON.stringify(s.dialect.statusBreakdown)}`
  );
  for (const r of s.dialect.nonOk.slice(0, 12)) {
    console.log(`   • ${pad(r.pattern, 22)} → ${JSON.stringify(r.statusDistribution)}`);
  }
}

/**
 * The headline output: every grep case that is slow (p95 over the threshold),
 * hit the query-timeout ceiling, or errored — sorted worst-first, with the exact
 * pattern + source so the offending shape is obvious.
 */
function slowCases(results: QueryStats[]): QueryStats[] {
  return results
    .filter(
      (r) =>
        r.p95 >= SLOW_THRESHOLD_MS ||
        r.errors > 0 ||
        (r.statusDistribution['408'] ?? 0) > 0 ||
        (r.statusDistribution['500'] ?? 0) > 0
    )
    .sort((a, b) => b.p95 - a.p95);
}

function printSlowCases(results: QueryStats[]): void {
  const slow = slowCases(results);
  console.log(`\n── Slow / problem cases (p95 ≥ ${SLOW_THRESHOLD_MS}ms, timeouts, or errors) ──`);
  if (slow.length === 0) {
    console.log('   none — every case stayed under the threshold and returned 200');
    return;
  }
  console.log(
    `${pad('pattern', 26)} ${pad('source', 14)} ${pad('category', 18)} ${padL('p95', 8)} ${padL('max', 9)} ${pad('status', 16)}`
  );
  console.log('-'.repeat(94));
  for (const r of slow) {
    const source = (r.coverage.find((c) => c.startsWith('source:')) ?? 'source:?').slice(7);
    const hitCap = (r.statusDistribution['408'] ?? 0) > 0 || (r.statusDistribution['500'] ?? 0) > 0;
    const flag = hitCap ? '  ⚠️ TIMEOUT/ERR' : r.p95 >= SLOW_THRESHOLD_MS ? '  SLOW' : '';
    console.log(
      `${pad(r.pattern.slice(0, 25), 26)} ${pad(source, 14)} ${pad(r.category, 18)} ${padL(r.p95, 8)} ${padL(r.max, 9)} ${pad(JSON.stringify(r.statusDistribution), 16)}${flag}`
    );
  }
}

// ---------------------------------------------------------------------------
// Compare mode
// ---------------------------------------------------------------------------

function compare(fileA: string, fileB: string): void {
  const a = JSON.parse(readFileSync(fileA, 'utf8')) as { results: QueryStats[]; meta: unknown };
  const b = JSON.parse(readFileSync(fileB, 'utf8')) as { results: QueryStats[]; meta: unknown };
  const byName = new Map(a.results.map((r) => [r.name, r]));
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const padL = (s: string | number, n: number) => String(s).padStart(n);
  console.log(`\nCompare  A=${fileA}  →  B=${fileB}\n`);
  console.log(
    `${pad('query', 30)} ${padL('A p50', 9)} ${padL('B p50', 9)} ${padL('Δ ms', 9)} ${padL('Δ %', 8)}`
  );
  console.log('-'.repeat(70));
  const rows = b.results
    .map((rb) => {
      const ra = byName.get(rb.name);
      const da = ra ? round(rb.p50 - ra.p50) : 0;
      const pct = ra && ra.p50 > 0 ? round(((rb.p50 - ra.p50) / ra.p50) * 100) : 0;
      return { name: rb.name, a: ra?.p50 ?? null, b: rb.p50, da, pct };
    })
    .sort((x, y) => y.da - x.da);
  for (const r of rows) {
    const sign = r.da > 0 ? '+' : '';
    console.log(
      `${pad(r.name, 30)} ${padL(r.a ?? '-', 9)} ${padL(r.b, 9)} ${padL(`${sign}${r.da}`, 9)} ${padL(`${sign}${r.pct}%`, 8)}`
    );
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv[0] === 'compare') {
    if (!argv[1] || !argv[2]) throw new Error('usage: compare <runA.json> <runB.json>');
    compare(argv[1], argv[2]);
    return;
  }

  const cfg = parseArgs(argv);

  assertLocalDatabase(cfg.allowRemoteDb);

  if (cfg.cleanupOnly) {
    await cleanup();
    console.log(`Cleaned up eval corpus for user ${EVAL_USER_ID}`);
    return;
  }

  let seedResult: SeedResult | null = null;
  if (cfg.seed) {
    console.log(`Seeding deterministic corpus (scale=${cfg.scale})...`);
    const t0 = performance.now();
    seedResult = await seed(cfg.scale);
    console.log(
      `Seeded in ${round((performance.now() - t0) / 1000)}s: ` +
        `${seedResult.counts.messages} messages, ${seedResult.counts.contacts} contacts, ` +
        `${seedResult.counts.agents} agents, ${seedResult.counts.agentMessages} agent messages`
    );
  }

  if (cfg.seedOnly) {
    console.log('Seed-only mode — exiting before benchmark.');
    return;
  }

  // Resolve an agent id for agent_network queries (deepest leaf → full tree walk).
  let agentId: string;
  if (seedResult) {
    agentId = seedResult.leafAgentId;
  } else {
    const leaf = await prisma.agent.findFirst({
      where: { userId: EVAL_USER_ID },
      orderBy: { depth: 'desc' },
      select: { id: true },
    });
    if (!leaf) throw new Error('No seeded corpus found. Run without --no-seed first.');
    agentId = leaf.id;
  }

  await checkBackend();

  const suite = buildSuite();
  console.log(
    `Running ${suite.length} queries × ${cfg.iterations} iters (warmup ${cfg.warmup})...`
  );
  // Run cheap, always-200 cases first; slow safety/dialect probes (which can hit
  // the 10s cap) last — so a budget cut-off still captures the full latency
  // picture and the slow probes use only the remaining time.
  const costRank = (s: QuerySpec): number =>
    s.expect === 'bounded' ? 2 : s.expect === 'observe' ? 1 : 0;
  const ordered = [...suite].sort((a, b) => costRank(a) - costRank(b));

  const results: QueryStats[] = [];
  const suiteStart = performance.now();
  let truncated = false;
  for (const spec of ordered) {
    if (performance.now() - suiteStart > GLOBAL_BUDGET_MS) {
      truncated = true;
      console.log(
        `\n⏱  Global budget (${GLOBAL_BUDGET_MS}ms) hit at ${results.length}/${suite.length} — writing partial report.`
      );
      break;
    }
    const stats = await runQuery(spec, cfg, agentId);
    results.push(stats);
    process.stdout.write('.');
  }
  console.log('');

  printLatencyTable(results, 25);
  printSlowCases(results);
  const rollup = categoryRollup(results);
  console.log('\nCategory p50 rollup (ms):', JSON.stringify(rollup));
  const coverage = coverageMatrix(results);
  console.log(`\nCoverage: ${results.length} cases across ${Object.keys(coverage).length} tags`);
  const safety = safetySummary(results);
  printSafety(safety);

  const report = {
    meta: {
      timestamp: isoNow(),
      gitSha: gitSha(),
      baseUrl: BASE_URL,
      config: cfg,
      suiteSize: results.length,
      suiteTotal: suite.length,
      truncated,
      volume: seedResult?.counts ?? 'reused-existing-corpus',
    },
    categoryRollup: rollup,
    coverageMatrix: coverage,
    slowCases: slowCases(results).map((r) => ({
      pattern: r.pattern,
      category: r.category,
      coverage: r.coverage,
      p95: r.p95,
      max: r.max,
      statusDistribution: r.statusDistribution,
    })),
    safety: {
      redos: { total: safety.redos.total, passed: safety.redos.passed },
      invalid: { total: safety.invalid.total, passed: safety.invalid.passed },
      dialect: { total: safety.dialect.total, statusBreakdown: safety.dialect.statusBreakdown },
    },
    results,
  };

  mkdirSync(RUNS_DIR, { recursive: true });
  const outPath =
    cfg.outPath ?? join(RUNS_DIR, `${isoNow().replace(/[:.]/g, '-')}-${gitSha()}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${outPath}`);
  console.log(`Diff two runs with: tsx scripts/grep-latency-eval.ts compare <old.json> ${outPath}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
