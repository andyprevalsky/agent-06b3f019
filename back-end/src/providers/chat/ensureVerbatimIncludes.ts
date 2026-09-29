/**
 * Enforce explicit "Include TOKEN verbatim" user instructions in the
 * user-facing chat response.
 *
 * rose-fast Qwen (Cerebras) sometimes refuses these tokens as "injection
 * tests" and omits them from `response` (semantic web_search lifecycle,
 * 2026-09-29). When the user explicitly asked for a verbatim include, the
 * token must still appear in the final answer.
 */

const INCLUDE_VERBATIM_RE = /\bInclude\s+(\S+)\s+verbatim\b/gi;

export function ensureVerbatimIncludes(userTexts: readonly string[], response: string): string {
  let out = response;
  for (const text of userTexts) {
    INCLUDE_VERBATIM_RE.lastIndex = 0;
    for (const match of text.matchAll(INCLUDE_VERBATIM_RE)) {
      const token = match[1];
      if (!token || out.includes(token)) continue;
      out = `${out.trimEnd()}\n\n${token}`;
    }
  }
  return out;
}
