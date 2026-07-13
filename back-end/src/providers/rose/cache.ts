/**
 * Cache-control helper for chat-side LLM call sites.
 *
 * The motivation: routerLlm, generatorLlm, and the SMS supervisorHandler all
 * pass a static system prompt that is identical across calls within an
 * Anthropic 5-minute ephemeral window, plus (sometimes) a dynamic suffix
 * that changes per-call. We want prompt caching to apply *only* to the
 * static prefix — caching the dynamic suffix would invalidate every call.
 *
 * Historically this was done by embedding a `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`
 * sentinel inside the prompt string and letting `transformMessagesForAnthropic`
 * split on it during the claudeAuth path (see transforms.ts). That works, but
 * the cache structure isn't visible at the call site — a future contributor
 * reading routerLlm.ts can't see "this prefix is cacheable" without chasing
 * through the transforms.
 *
 * `markCacheable` makes the cache boundary explicit. Each chat call site
 * builds its system message via this helper; the helper produces a
 * `CompletionMessage` whose content shape is unambiguous about which portion
 * is cache-stable and which is per-call dynamic state.
 *
 * The implementation still uses the boundary sentinel under the hood so the
 * existing `transformMessagesForAnthropic` split mechanic and any
 * legacy/string-based callers continue to work. The helper is a thin wrapper
 * that centralizes the formatting and documents the contract.
 *
 * Usage:
 *   const systemMessage = markCacheable(STATIC_PROMPT);            // entire prompt static
 *   const systemMessage = markCacheable(STATIC_PROMPT, dynamicTail); // static prefix, dynamic tail
 */

import type { CompletionMessage } from './types';

/**
 * Sentinel matched by `transformMessagesForAnthropic` (transforms.ts) to split
 * the system prompt into a globally-cacheable "static" prefix and a per-call
 * "dynamic" suffix. Anything before the boundary becomes a
 * `cache_control: { type: 'ephemeral', scope: 'global' }` block on the
 * Anthropic claudeAuth path.
 *
 * Exported so chat-side call sites that don't use `markCacheable` (legacy
 * paths) can still reference the canonical sentinel value rather than
 * hard-coding it.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\n';

/**
 * Build a system-role `CompletionMessage` with an explicit cache boundary.
 *
 * The returned message is a plain `{ role: 'system', content: string }` so it
 * passes through both the claudeAuth and waterfall paths without any further
 * transformation:
 *   - On the claudeAuth path, `transformMessagesForAnthropic` recognizes the
 *     embedded boundary, splits at it, and `claudeAuth.ts` applies
 *     `cache_control: { type: 'ephemeral', scope: 'global' }` to the static
 *     prefix.
 *   - On the waterfall path (OpenRouter), the boundary sentinel is harmless
 *     extra text in the system prompt — non-Anthropic models simply ignore it.
 *
 * @param staticPrefix
 *   The cache-stable portion of the system prompt. This is what gets the
 *   `cache_control: ephemeral` marker on Anthropic. MUST NOT contain
 *   per-call dynamic state (current datetime, agent hierarchy, etc.) — that
 *   lives in `dynamicSuffix` or, for runtime state, in a non-persisted tool
 *   result after the current user message (see the SMS supervisor pattern).
 * @param dynamicSuffix
 *   Optional per-call portion appended after the boundary. Use sparingly —
 *   on the claudeAuth path this is *not* cached. Most call sites should
 *   leave this empty and inject dynamic state after the stable conversation
 *   prefix instead.
 */
export function markCacheable(
  staticPrefix: string,
  dynamicSuffix?: string
): CompletionMessage & { role: 'system'; content: string } {
  const trimmedStatic = staticPrefix.trimEnd();
  const trimmedDynamic = dynamicSuffix?.trimStart() ?? '';

  const content = trimmedDynamic
    ? `${trimmedStatic}${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}${trimmedDynamic}`
    : `${trimmedStatic}${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}`;

  return { role: 'system', content };
}
