#!/usr/bin/env tsx
/**
 * Keep the RCA case archive (docs/rca/) trustworthy and wired into /RCA.
 *
 * Why this exists: `docs/rca/cases/` is the checked-in memory of every RCA this
 * repo has completed — problem, diagnosis, solution, human feedback. /RCA greps
 * it before forming a hypothesis, so it only pays for itself if (a) the case
 * files actually conform to the schema the search tool parses, and (b) the /RCA
 * instructions keep telling agents to search it and write to it. Both degrade
 * silently: a malformed case file drops out of search results with no error, and
 * an instruction edit can quietly delete the search step. Either failure is
 * invisible until an agent re-diagnoses a bug we already solved.
 *
 * What this test does:
 *   1. Runs `python3 scripts/rca_archive.py validate`, the single source of truth
 *      for the case schema (required frontmatter, enum values, the five required
 *      sections, unique ids, no TODO placeholders, INDEX.md not committed).
 *   2. Asserts the archive is non-empty — an empty archive means the write-back
 *      step stopped running.
 *   3. Asserts /RCA and the methodology doc still instruct agents to search the
 *      archive AND write a case back to it.
 *
 * What this test does NOT catch: whether a case's diagnosis is correct, or
 * whether an agent actually ran the search. Only that the mechanism is intact.
 */
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CASES_DIR = path.join(REPO_ROOT, 'docs/rca/cases');
const VALIDATOR = path.join(REPO_ROOT, 'scripts/rca_archive.py');
const HISTORICAL_BACKFILL_MIN_CASES = 270;

const failures: string[] = [];
const writeOut = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const writeError = (text: string): void => {
  process.stderr.write(`${text}\n`);
};

// 1. Schema + index freshness, delegated to the validator so the rules live in
//    exactly one place.
if (!fs.existsSync(VALIDATOR)) {
  failures.push(
    `Missing ${path.relative(REPO_ROOT, VALIDATOR)} — the RCA archive validator is the ` +
      `single source of truth for the case schema and must not be deleted.`
  );
} else {
  try {
    const out = execFileSync('python3', [VALIDATOR, 'validate'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    writeOut(out.trim());
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    failures.push(
      `rca_archive.py validate failed:\n${(err.stderr ?? '').trim()}\n${(err.stdout ?? '').trim()}\n` +
        `    Fix: correct the reported case files, then run ` +
        `\`python3 scripts/rca_archive.py reindex\`.`
    );
  }
}

// 2. A non-empty archive. Zero cases means /RCA's write-back step is dead.
const caseFiles = fs.existsSync(CASES_DIR)
  ? fs.readdirSync(CASES_DIR).filter((f) => f.endsWith('.md'))
  : [];
if (caseFiles.length < HISTORICAL_BACKFILL_MIN_CASES) {
  failures.push(
    `docs/rca/cases/ has ${caseFiles.length} case files, below the historical backfill ` +
      `floor of ${HISTORICAL_BACKFILL_MIN_CASES}. Cases are append-only; restore any deleted ` +
      `files, then reindex.`
  );
}

// 3. The search command itself must retrieve a known historical case. Schema
//    validity is not enough if ranking changes make the archive undiscoverable.
if (fs.existsSync(VALIDATOR)) {
  try {
    const result = execFileSync(
      'python3',
      [
        VALIDATOR,
        'search',
        'read_network_requests capture is not active response bodies',
        '--limit',
        '3',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    if (!result.includes('2026-07-28-network-capture-bodies-written-to-dev-only-file')) {
      failures.push(
        `RCA archive search did not retrieve the known network-capture case.\n` +
          `    Search output:\n${result.trim()}`
      );
    }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    failures.push(
      `rca_archive.py search failed:\n${(err.stderr ?? '').trim()}\n${(err.stdout ?? '').trim()}`
    );
  }
}

// 4. The documented `new` command must actually dispatch. Exercise a copied
//    validator in a temporary archive so this structural test never mutates the
//    checked-in cases.
if (fs.existsSync(VALIDATOR)) {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rca-archive-new-'));
  const probeValidator = path.join(probeRoot, 'scripts/rca_archive.py');
  const probeCase = path.join(probeRoot, 'docs/rca/cases/2099-01-02-dispatch-probe.md');

  try {
    fs.mkdirSync(path.dirname(probeValidator), { recursive: true });
    fs.mkdirSync(path.dirname(probeCase), { recursive: true });
    fs.copyFileSync(VALIDATOR, probeValidator);

    const result = execFileSync('python3', [probeValidator, 'new', 'dispatch-probe'], {
      cwd: probeRoot,
      encoding: 'utf8',
      env: { ...process.env, RCA_ARCHIVE_DATE: '2099-01-02' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!fs.existsSync(probeCase) || !result.includes('2099-01-02-dispatch-probe.md')) {
      failures.push(
        `rca_archive.py new did not scaffold the requested case.\n` +
          `    Command output:\n${result.trim()}`
      );
    } else {
      const scaffold = fs.readFileSync(probeCase, 'utf8');
      fs.writeFileSync(
        probeCase,
        scaffold
          .replace(/^classification: .*$/m, 'classification: unresolved')
          .replace(/^status: open$/m, 'status: fixed')
      );
      try {
        execFileSync('python3', [probeValidator, 'validate'], {
          cwd: probeRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        failures.push('RCA archive accepted an unresolved case marked fixed.');
      } catch (error) {
        const err = error as { stdout?: string; stderr?: string };
        if (
          !`${err.stdout ?? ''}\n${err.stderr ?? ''}`.includes(
            '`unresolved` classification requires `status: open`'
          )
        ) {
          failures.push('RCA archive did not report the unresolved/fixed classification error.');
        }
      }
    }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    failures.push(
      `rca_archive.py new failed:\n${(err.stderr ?? '').trim()}\n${(err.stdout ?? '').trim()}`
    );
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

// 5. An investigation may leave classification undetermined only while open.
//    Exercise the CLI with valid case documents and a fresh index so enum and
//    lifecycle failures cannot be confused with malformed fixture metadata.
if (fs.existsSync(VALIDATOR)) {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rca-archive-classification-'));
  const probeValidator = path.join(probeRoot, 'scripts/rca_archive.py');
  const probeCase = path.join(probeRoot, 'docs/rca/cases/2099-01-02-classification-probe.md');
  const scenarios = [
    { classification: 'undetermined', status: 'open', accepted: true },
    ...['fixed', 'mitigated', 'wontfix', 'superseded', 'resolved'].map((status) => ({
      classification: 'undetermined',
      status,
      accepted: false,
    })),
    { classification: 'our-bug', status: 'fixed', accepted: true },
    { classification: 'invented-class', status: 'open', accepted: false },
    { classification: 'our-bug', status: 'invented-status', accepted: false },
  ];

  try {
    fs.mkdirSync(path.dirname(probeValidator), { recursive: true });
    fs.mkdirSync(path.dirname(probeCase), { recursive: true });
    fs.copyFileSync(VALIDATOR, probeValidator);
    for (const scenario of scenarios) {
      fs.writeFileSync(
        probeCase,
        `---
id: 2099-01-02-classification-probe
date: 2099-01-02
title: Classification lifecycle probe
surface: harness
component: rca-archive
classification: ${scenario.classification}
problem_class: other
first_bad_boundary: Captured result awaiting causal classification
symptoms:
  - A completed task did not terminate
  - Causal classification remains unresolved
tags:
  - classification
sources:
  - PR #1299
repro: none-recorded
status: ${scenario.status}
---

## Problem
The recorded outcome requires investigation.

## Diagnosis
Causal classification remains unresolved in this probe.

## Solution
Record the lifecycle without inventing a cause.

## Human feedback
None recorded.

## Reusable lesson
Keep unresolved classifications open.
`
      );
      execFileSync('python3', [probeValidator, 'reindex'], {
        cwd: probeRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const result = spawnSync('python3', [probeValidator, 'validate'], {
        cwd: probeRoot,
        encoding: 'utf8',
      });
      if (result.error || result.signal || result.status === null) {
        failures.push(
          `Classification probe did not execute: ${String(result.error ?? result.signal)}`
        );
      } else if ((result.status === 0) !== scenario.accepted) {
        failures.push(
          `Classification ${scenario.classification} / ${scenario.status}: expected ` +
            `${scenario.accepted ? 'acceptance' : 'rejection'}, got exit ${result.status}.\n` +
            `${result.stdout}${result.stderr}`
        );
      }
    }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    failures.push(
      `RCA classification probe failed: ${err.message}\n${err.stdout ?? ''}${err.stderr ?? ''}`
    );
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

// 6. The instructions must keep pointing at the archive in both directions:
//    read it before diagnosing, write to it after.
const INSTRUCTION_REQUIREMENTS: Array<{ file: string; needles: string[]; why: string }> = [
  {
    file: '.claude/commands/rca.md',
    needles: [
      'scripts/rca_archive.py search',
      'scripts/rca_archive.py new',
      'docs/rca/cases/',
      'docs/rca/process-feedback.md',
    ],
    why: '/RCA must instruct agents to search the archive before diagnosing and write a case after.',
  },
  {
    file: 'docs/root-cause-analysis.md',
    needles: [
      'scripts/rca_archive.py search',
      'scripts/rca_archive.py new',
      'docs/rca/cases/',
      'docs/rca/process-feedback.md',
    ],
    why: 'The methodology is the source of truth /RCA reads first; the archive steps must live there too.',
  },
];

for (const { file, needles, why } of INSTRUCTION_REQUIREMENTS) {
  const abs = path.join(REPO_ROOT, file);
  if (!fs.existsSync(abs)) {
    failures.push(`Missing ${file} — ${why}`);
    continue;
  }
  const text = fs.readFileSync(abs, 'utf8');
  for (const needle of needles) {
    if (!text.includes(needle)) {
      failures.push(`${file} no longer mentions \`${needle}\`.\n    ${why}`);
    }
  }
}

if (failures.length === 0) {
  writeOut(`RCA archive structural checks passed (${caseFiles.length} cases).`);
  process.exit(0);
}

writeError('RCA archive structural check failed:');
for (const failure of failures) {
  writeError(`  - ${failure}`);
}
writeError(
  `\nWhy this matters: the RCA archive is how a diagnosis survives past one context\n` +
    `window. A malformed case silently drops out of \`rca_archive.py search\`, and an\n` +
    `instruction that stops naming the archive means the next agent re-diagnoses a bug\n` +
    `we already paid to solve.`
);
process.exit(1);
