/**
 * Rose-Bench Runtime
 *
 * Thin HTTP handler: parse input → call service → serialize response.
 * Runtime layer: imports own service / types / config only.
 */

import type { BenchmarkRequest, CreateSupabaseClientFn, FetchFn } from './types.ts';
import { corsHeaders } from './config.ts';
import {
  isFullBenchmark,
  isKnownBenchmark,
  listBenchmarkKeys,
  logBenchmarkRun,
  runFullBenchmark,
  runSingleBenchmark,
  validateBenchmarkUrl,
} from './service.ts';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  });
}

export interface HandlerDeps {
  createSupabaseClient: CreateSupabaseClientFn;
  /** Injected logger so the handler stays no-console under strict lint. */
  logError: (message: string, err: unknown) => void;
  /** Injectable fetch used for the model HTTP boundary; defaults to global fetch. */
  fetchFn?: FetchFn;
}

export function createHandler(
  deps: HandlerDeps,
): (req: Request) => Promise<Response> {
  const { createSupabaseClient, logError, fetchFn } = deps;

  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (req.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    try {
      const body = await req.json() as Partial<BenchmarkRequest>;
      const { url, headers, modelConfig, benchmark, seed } = body;

      if (!url) {
        return jsonResponse({ error: 'Missing required field: url' }, 400);
      }

      let validatedUrl: string;
      try {
        validatedUrl = validateBenchmarkUrl(url);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'validation failed';
        return jsonResponse({ error: `Invalid url: ${message}` }, 400);
      }

      if (!modelConfig || !modelConfig.model) {
        return jsonResponse(
          { error: 'Missing required field: modelConfig with model' },
          400,
        );
      }

      if (!benchmark) {
        return jsonResponse(
          { error: 'Missing required field: benchmark' },
          400,
        );
      }

      if (!isKnownBenchmark(benchmark)) {
        return jsonResponse(
          {
            error: `Invalid benchmark type: ${benchmark}`,
            availableBenchmarks: listBenchmarkKeys(),
          },
          400,
        );
      }

      if (isFullBenchmark(benchmark)) {
        const full = await runFullBenchmark({
          url: validatedUrl,
          headers: headers ?? {},
          modelConfig,
          seed,
          fetchFn,
        }, logError);
        return jsonResponse(full, 200);
      }

      const result = await runSingleBenchmark({
        url: validatedUrl,
        headers: headers ?? {},
        modelConfig,
        benchmarkName: benchmark,
        seed,
        fetchFn,
      }, logError);

      const logResult = await logBenchmarkRun(
        createSupabaseClient,
        modelConfig,
        result,
      );
      if (!logResult.ok) {
        logError('Failed to log benchmark run:', logResult.reason);
      }

      return jsonResponse(result, 200);
    } catch (error) {
      logError('Benchmark error:', error);
      return jsonResponse({ error: 'Failed to run benchmark' }, 500);
    }
  };
}
