#!/usr/bin/env node
// Plan a deterministic blackbox-domain shard for scripts/run-coverage.sh.
//
// Usage: node scripts/coverage-shard-plan.mjs <index>/<count> [durations-summary.json]
// Prints the comma-separated blackbox domains assigned to shard <index>
// (1-based). Every domain lands in exactly one shard. With a prior
// coverage/blackbox-run/summary.json, domains are balanced by recorded
// duration (longest-processing-time first); otherwise by name round-robin.
// Domains in BLACKBOX_TEST_SKIP_DOMAINS are never assigned.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [spec, durationsPath] = process.argv.slice(2);
const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(spec ?? '');
if (!match || Number(match[1]) > Number(match[2])) {
  console.error('usage: coverage-shard-plan.mjs <index>/<count> [summary.json]');
  process.exit(2);
}
const index = Number(match[1]);
const count = Number(match[2]);

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const blackboxDir = join(backendDir, 'src', 'tests', 'blackbox');
const skip = new Set(
  (process.env.BLACKBOX_TEST_SKIP_DOMAINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
const domains = readdirSync(blackboxDir)
  .filter((f) => f.endsWith('.blackbox.ts'))
  .map((f) => f.replace(/\.blackbox\.ts$/, ''))
  .filter((d) => !skip.has(d))
  .sort();

const durations = new Map();
if (durationsPath && existsSync(durationsPath)) {
  const summary = JSON.parse(readFileSync(durationsPath, 'utf8'));
  for (const result of summary.results ?? []) {
    if (typeof result.duration === 'number') durations.set(result.domain, result.duration);
  }
}
// run.ts runs its late-exclusive domains serially after the parallel pool, so
// balance them as their own serial phase; everything else shares the pool.
const runSource = readFileSync(join(blackboxDir, 'run.ts'), 'utf8');
const exclusiveBlock = /lateExclusiveDomainNames = new Set\(\[([\s\S]*?)\]\)/.exec(runSource);
const exclusive = new Set([...(exclusiveBlock?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]));
const fallback = 30_000;
const weight = (domain) => durations.get(domain) ?? fallback;
const assigned = Array.from({ length: count }, () => []);
const phases = [domains.filter((d) => exclusive.has(d)), domains.filter((d) => !exclusive.has(d))];
for (const phase of phases) {
  const loads = Array.from({ length: count }, () => 0);
  const ordered = [...phase].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  for (const domain of ordered) {
    let target = 0;
    for (let i = 1; i < count; i++) if (loads[i] < loads[target]) target = i;
    loads[target] += weight(domain);
    assigned[target].push(domain);
  }
}
const mine = assigned[index - 1].sort();
if (mine.length === 0) {
  console.error(`shard ${spec} has no blackbox domains`);
  process.exit(1);
}
process.stdout.write(`${mine.join(',')}\n`);
