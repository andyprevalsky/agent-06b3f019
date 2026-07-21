/**
 * Regex safety + dialect normalization for the DB-backed Grep.
 *
 * User/model-supplied regex flows into Postgres `~`, whose backtracking engine
 * will not honor statement_timeout mid-match — so a catastrophic pattern is a
 * DoS. And JS `RegExp` (used for validation) accepts constructs Postgres ARE
 * does not. These pure helpers gate and normalize the pattern before it runs.
 */

import { checkSync } from 'recheck';

// Hard cap so a giant pattern can't itself be a DoS.
const MAX_PATTERN_LENGTH = 1000;
// Quadratic (degree 2) regex is harmless over a single bounded DB row; degree ≥ 3
// or exponential can hang Postgres for seconds-to-minutes, so reject those.
const MAX_SAFE_POLYNOMIAL_DEGREE = 2;

export interface PatternSafety {
  ok: boolean;
  reason?: string;
}

/**
 * Classify a regex with `recheck` and reject genuinely dangerous shapes
 * (exponential, or polynomial degree > 2). Quadratic patterns like
 * `meeting.*tomorrow` stay allowed so we don't nerf realistic queries.
 */
export function checkPatternSafety(source: string, flags: string): PatternSafety {
  if (source.length > MAX_PATTERN_LENGTH) {
    return {
      ok: false,
      reason: `Pattern too long (${source.length} chars, max ${MAX_PATTERN_LENGTH}).`,
    };
  }
  let diagnostics;
  try {
    diagnostics = checkSync(source, flags, { timeout: 1000 });
  } catch {
    // The analyzer is the only guard against catastrophic backtracking. A
    // length cap alone cannot make short nested-quantifier patterns safe, so
    // analyzer errors and timeouts must fail closed before the pattern reaches
    // Postgres.
    return {
      ok: false,
      reason:
        'Pattern safety analysis did not complete. Use a simpler expression without nested quantifiers or stacked wildcards.',
    };
  }
  if (diagnostics.status !== 'vulnerable') return { ok: true };
  const complexity = diagnostics.complexity;
  const tooComplex =
    complexity?.type === 'exponential' ||
    (complexity?.type === 'polynomial' && (complexity.degree ?? 0) > MAX_SAFE_POLYNOMIAL_DEGREE);
  if (!tooComplex) return { ok: true };
  const detail =
    complexity?.type === 'polynomial' ? `polynomial degree ${complexity.degree}` : 'exponential';
  return {
    ok: false,
    reason:
      `Pattern rejected as potentially catastrophic to evaluate (ReDoS, ${detail}). ` +
      `Avoid nested quantifiers like (x+)+ or stacked wildcards; use a simpler form ` +
      `such as [\\w.]+ or an explicit pattern.`,
  };
}

/**
 * Fold a bare inline-flag group like `(?i)` into case-insensitivity. JS RegExp
 * and Postgres ARE both reject inline flags, so without this the pattern errors;
 * scoped groups `(?i:…)` and non-capturing `(?:…)` are left untouched.
 */
export function extractInlineFlags(pattern: string): { pattern: string; caseInsensitive: boolean } {
  let caseInsensitive = false;
  const stripped = pattern.replace(/\(\?([a-zA-Z]+)\)/g, (match, flagChars: string) => {
    if (!/^[imsxu]+$/.test(flagChars)) return match;
    if (flagChars.includes('i')) caseInsensitive = true;
    return '';
  });
  return { pattern: stripped, caseInsensitive };
}

/**
 * Postgres ARE has no named-capture syntax. We only do boolean matching, so
 * `(?<name>X)` is equivalent to `(X)`. Lookbehind `(?<=…)`/`(?<!…)` has no name,
 * so it is left intact.
 */
export function stripNamedGroups(pattern: string): string {
  return pattern.replace(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g, '(');
}

/** True if a thrown DB error is a Postgres "invalid regular expression" (SQLSTATE 2201B). */
export function isPostgresRegexError(error: unknown): boolean {
  const e = error as { code?: string; meta?: { code?: string }; message?: string };
  return (
    e?.meta?.code === '2201B' ||
    e?.code === '2201B' ||
    /2201B|invalid regular expression/i.test(e?.message ?? '')
  );
}
