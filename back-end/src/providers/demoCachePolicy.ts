/**
 * DEMO-tag demo-cache policy.
 *
 * Cache replay is gated by matching the agent (or tree-root) goal against a
 * tasks.json entry tagged DEMO — not by the Fast Mode button. The button only
 * controls LLM provider_fast_mode (Anthropic speed / OpenAI priority).
 *
 * Keep the OAi prefix fallback in sync with
 * agents/providers/demo_cache/normalize.py::demo_cache_allowed.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isOaiDemoGoal, canonicalizeOaiDemoGoalForHash } from './demoCacheNormalizeOaiDemo';

export const OAI_DEMO_ROOT_GOAL_HASH = '4ae3193053ac1d8f';

const DEMO_TAG = 'DEMO';
let cachedDemoHashes: ReadonlySet<string> | null = null;

function sha16(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Mirror agents/providers/demo_cache/normalize.py::goal_hash for catalog prompts. */
export function demoGoalHash(goal: string): string {
  const canonical = canonicalizeOaiDemoGoalForHash(
    goal.replace(/@ref:message:[0-9a-f-]{36}/gi, '@ref:message:<uuid>')
  );
  return sha16(canonical);
}

function taskHasDemoTag(task: Record<string, unknown>): boolean {
  const tags = task.tags;
  if (!Array.isArray(tags)) return false;
  return tags.some((tag) => String(tag).trim().toUpperCase() === DEMO_TAG);
}

function tasksJsonPath(): string {
  const candidates = [
    join(process.cwd(), '..', 'agents', 'benchmarks', 'tasks.json'),
    join(process.cwd(), 'agents', 'benchmarks', 'tasks.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

export function demoCacheGoalHashes(): ReadonlySet<string> {
  if (cachedDemoHashes) return cachedDemoHashes;
  const hashes = new Set<string>([OAI_DEMO_ROOT_GOAL_HASH]);
  try {
    const tasks = JSON.parse(readFileSync(tasksJsonPath(), 'utf8')) as unknown;
    if (Array.isArray(tasks)) {
      for (const task of tasks) {
        if (task === null || typeof task !== 'object') continue;
        const row = task as Record<string, unknown>;
        const demoCacheOn =
          String(row.demo_cache ?? row.fast_cache ?? '')
            .trim()
            .toLowerCase() === 'on';
        if (!taskHasDemoTag(row) && !demoCacheOn) continue;
        const prompt = row.prompt;
        if (typeof prompt === 'string' && prompt.trim()) {
          hashes.add(demoGoalHash(prompt));
        }
      }
    }
  } catch {
    // Catalog unavailable in some unit-test / slim images — constant remains.
  }
  cachedDemoHashes = hashes;
  return hashes;
}

/** Reset catalog memo (unit tests). */
export function resetDemoCacheGoalHashes(): void {
  cachedDemoHashes = null;
}

export function demoCacheAllowed(
  goal: string | null | undefined,
  rootGoal?: string | null
): boolean {
  const allowed = demoCacheGoalHashes();
  if (goal && allowed.has(demoGoalHash(goal))) return true;
  if (rootGoal && allowed.has(demoGoalHash(rootGoal))) return true;
  if (isOaiDemoGoal(goal) || isOaiDemoGoal(rootGoal)) return true;
  return false;
}
