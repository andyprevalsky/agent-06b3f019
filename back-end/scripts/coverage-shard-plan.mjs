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
// Each shard runs its parallel domains through run.ts's pool (static weights
// first, then by name) and its exclusive domains serially afterwards. With
// recorded durations, pack by the shard's simulated wall (serial sum + pool
// makespan) instead of by summed duration: a 250 s domain bounds its shard's
// pool wall no matter how light the rest of that shard is.
const weightsBlock = /domainWeights = new Map<string, number>\(\[([\s\S]*?)\]\)/.exec(runSource);
const staticWeights = new Map(
  [...(weightsBlock?.[1] ?? '').matchAll(/\['([^']+)',\s*(\d+)\]/g)].map((m) => [
    m[1],
    Number(m[2]),
  ])
);
const rawPool = Number(
  process.env.BLACKBOX_TEST_CONCURRENCY ?? process.env.CONTRACT_TEST_CONCURRENCY ?? 4
);
const pool = Number.isInteger(rawPool) && rawPool > 0 ? rawPool : 4;
const poolOrder = (a, b) =>
  (staticWeights.get(b) ?? 0) - (staticWeights.get(a) ?? 0) || a.localeCompare(b);
const poolMakespan = (members) => {
  const free = Array.from({ length: pool }, () => 0);
  let end = 0;
  for (const domain of [...members].sort(poolOrder)) {
    let target = 0;
    for (let i = 1; i < pool; i++) if (free[i] < free[target]) target = i;
    free[target] += weight(domain);
    end = Math.max(end, free[target]);
  }
  return end;
};
const assigned = Array.from({ length: count }, () => []);
const wall = (shard, extra) => {
  const members = extra === undefined ? shard : [...shard, extra];
  const serial = members.filter((d) => exclusive.has(d)).reduce((sum, d) => sum + weight(d), 0);
  return serial + poolMakespan(members.filter((d) => !exclusive.has(d)));
};
const phases = [domains.filter((d) => exclusive.has(d)), domains.filter((d) => !exclusive.has(d))];
if (durations.size === 0) {
  // No observations: deterministic longest-processing-time by name order.
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
} else {
  const ordered = [...phases[0], ...phases[1]].sort(
    (a, b) => weight(b) - weight(a) || a.localeCompare(b)
  );
  for (const domain of ordered) {
    let target = 0;
    let best = Infinity;
    for (let i = 0; i < count; i++) {
      const projected = wall(assigned[i], domain);
      if (projected < best - 1e-9) {
        best = projected;
        target = i;
      }
    }
    assigned[target].push(domain);
  }
}
const mine = assigned[index - 1].sort();
if (mine.length === 0) {
  console.error(`shard ${spec} has no blackbox domains`);
  process.exit(1);
}
process.stdout.write(`${mine.join(',')}\n`);
