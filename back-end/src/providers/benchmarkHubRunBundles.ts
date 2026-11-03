import { normalizeAgentId } from './benchmarkHubRunProjection';
import type { HubRunSummary } from './benchmarkHubTypes';
/** Exact run-bundle reads, independent of catalog mutation scheduling. */
import { BenchmarkHubUnavailableError } from './benchmarkHubErrors';
import { getObject, getObjectStrict, hubOverlayEnabled } from './benchmarkHubStorage';
import { createLogger } from './logger';

const log = createLogger('BenchmarkHubStore');

export async function getRunBundle(runId: string): Promise<Record<string, unknown> | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) return null;
  const raw = await getObject(`runs/${runId}.json`);
  if (!raw) return null;
  try {
    return parseHubRunBundle(raw);
  } catch {
    if (hubOverlayEnabled())
      throw new BenchmarkHubUnavailableError('Hub run bundle is temporarily unavailable');
    return null;
  }
}

/** Agent resolution preserves transport faults so callers do not cache a false miss. */
export async function getRunBundleForAgentLookup(
  runId: string
): Promise<Record<string, unknown> | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) return null;
  let raw: string | null;
  try {
    raw = await getObjectStrict(`runs/${runId}.json`);
  } catch (error: unknown) {
    log.warn('Benchmark Hub run bundle read is temporarily unavailable', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new BenchmarkHubUnavailableError(
      'Benchmark Hub run bundle is temporarily unavailable; retry shortly'
    );
  }
  if (raw === null) return null;
  try {
    return parseHubRunBundle(raw);
  } catch (error: unknown) {
    log.warn('Benchmark Hub run bundle is malformed', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Strictly parse a stored run bundle. Writers before 2026-10 stored any
 * non-array task list verbatim and cataloged that run with zero tasks; only a
 * caller holding that zero-task catalog summary may read it as an empty run.
 */
export function parseHubRunBundle(
  raw: string,
  catalogSummary?: { tasks: unknown[] }
): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid Benchmark Hub run bundle');
  }
  const bundle = parsed as Record<string, unknown>;
  if (Array.isArray(bundle.tasks)) return bundle;
  if (catalogSummary?.tasks.length === 0) return { ...bundle, tasks: [] };
  throw new Error('Invalid Benchmark Hub run bundle');
}

/** Legacy-index migration must distinguish an absent/corrupt bundle from success. */
export async function getRunBundleStrict(
  runId: string,
  catalogSummary?: { tasks: unknown[] }
): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`Invalid Hub run id: ${runId}`);
  const raw = await getObjectStrict(`runs/${runId}.json`);
  if (raw === null) throw new Error(`Missing Hub run bundle: ${runId}`);
  return parseHubRunBundle(raw, catalogSummary);
}

export function parseRunCatalog(raw: string): HubRunSummary[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Invalid Benchmark Hub run catalog');
  return parsed.map((value) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as Partial<HubRunSummary>).run_id !== 'string' ||
      !/^[A-Za-z0-9._-]+$/.test((value as Partial<HubRunSummary>).run_id as string) ||
      !Array.isArray((value as Partial<HubRunSummary>).tasks)
    ) {
      throw new Error('Invalid Benchmark Hub run catalog entry');
    }
    const run = value as HubRunSummary;
    return {
      ...run,
      tasks: run.tasks.map((task) => ({ ...task, agent_id: normalizeAgentId(task.agent_id) })),
    };
  });
}
