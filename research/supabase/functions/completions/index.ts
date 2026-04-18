/**
 * Rose completions edge function (runtime entry).
 *
 * This file is intentionally thin. All logic lives in
 * `research/domains/completions/` under the layered architecture:
 *
 *   types.ts          → shared schemas + interfaces
 *   config.ts         → constants, defaults, env reads
 *   utils.ts          → pure helpers (logging, JSON, timeouts, filters)
 *   repo.ts           → Supabase data access (API keys, latency cache, usage, conversation pinning)
 *   service/cost.ts            → pricing + model selection
 *   service/vision.ts          → screenshot / vision-message helpers
 *   service/anthropic.ts       → message / schema / tool transforms for Anthropic
 *   service/anthropic-cua.ts   → Anthropic Computer Use provider
 *   service/browser-use-native.ts → Browser-Use native provider (bu-1-0)
 *   service/yutori.ts          → Yutori N1 provider
 *   service/generic.ts         → OpenRouter-based generic browser-use provider + latency probes
 *   service/streaming.ts       → SSE streaming pipeline (Cerebras / Anthropic / OpenRouter)
 *   service/racing.ts          → trio selection, waterfall, race winners
 *   service/handler.ts         → request-level orchestration (this file's body used to live here)
 *
 * All the edge function does here is hand the incoming `Request` to
 * `handleCompletionsRequest`.
 */

import { serve } from 'https://deno.land/std@0.190.0/http/server.ts';

import { handleCompletionsRequest } from '../../../domains/completions/service/handler.ts';

serve(handleCompletionsRequest);
