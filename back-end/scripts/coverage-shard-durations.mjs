#!/usr/bin/env node
// Merge sharded blackbox run summaries into the per-worktree durations ledger
// that scripts/coverage-shard-plan.mjs reads (same shape: results[].domain +
// results[].duration in ms). Latest observation per domain wins; domains not
// observed this run keep their previous value. Aborted domains (never ran)
// are not observations. Usage: coverage-shard-durations.mjs <ledger> <summary.json>...
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [ledger, ...summaries] = process.argv.slice(2);
if (!ledger) {
  console.error('usage: coverage-shard-durations.mjs <ledger.json> <summary.json>...');
  process.exit(2);
}
const merged = new Map();
if (existsSync(ledger)) {
  try {
    for (const result of JSON.parse(readFileSync(ledger, 'utf8')).results ?? []) {
      if (typeof result.duration === 'number' && result.duration > 0)
        merged.set(result.domain, result.duration);
    }
  } catch {
    // An unreadable ledger is rebuilt from this run's observations.
  }
}
let observed = 0;
for (const file of summaries) {
  let summary;
  try {
    summary = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  for (const result of summary.results ?? []) {
    if (typeof result.duration !== 'number' || result.duration <= 0 || result.aborted === true)
      continue;
    merged.set(result.domain, result.duration);
    observed += 1;
  }
}
if (observed === 0) process.exit(0);
mkdirSync(dirname(ledger), { recursive: true });
const results = [...merged.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([domain, duration]) => ({ domain, duration }));
const temporary = `${ledger}.${process.pid}.tmp`;
writeFileSync(
  temporary,
  JSON.stringify({ schema_version: 1, recorded_at: new Date().toISOString(), results }, null, 2) +
    '\n'
);
renameSync(temporary, ledger);
console.log(`Recorded ${observed} blackbox domain duration(s) to ${ledger}`);
