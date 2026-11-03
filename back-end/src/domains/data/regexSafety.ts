/**
 * Regex safety + dialect normalization for the DB-backed Grep.
 *
 * User/model-supplied regex flows into Postgres `~`, whose backtracking engine
 * will not honor statement_timeout mid-match — so a catastrophic pattern is a
 * DoS. And JS `RegExp` (used for validation) accepts constructs Postgres ARE
 * does not. These pure helpers gate and normalize the pattern before it runs.
 */

import { checkSync } from 'recheck';

import { isClearlyAtMostQuadraticPattern } from './regexSafetyProof';

// Hard cap so a giant pattern can't itself be a DoS.
const MAX_PATTERN_LENGTH = 1000;
// Quadratic (degree 2) regex is harmless over a single bounded DB row; degree ≥ 3
// or exponential can hang Postgres for seconds-to-minutes, so reject those.
const MAX_SAFE_POLYNOMIAL_DEGREE = 2;
const RECHECK_TIMEOUT_MS = 1000;

export interface PatternSafety {
  ok: boolean;
  reason?: string;
}

function unclassifiedPatternRejection(): PatternSafety {
  return {
    ok: false,
    reason:
      'Pattern safety analysis did not complete. ' +
      'Use a simpler expression without nested quantifiers or stacked wildcards.',
  };
}

/**
 * Prove a deliberately narrow subset linear without invoking the heavier
 * analyzer. Literals, escaped characters, anchors, fixed-width dots, and at
 * most one `.*` cannot create nested or overlapping repetition. Everything
 * outside this subset still goes through recheck and fails closed if recheck
 * cannot classify it.
 */
function isClearlyLinearPattern(source: string): boolean {
  let wildcardCount = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '.' && source[index + 1] === '*') {
      wildcardCount += 1;
      if (wildcardCount > 1) return false;
      index += 1;
      continue;
    }
    if ('*+?()[]{}|'.includes(char)) return false;
  }
  return true;
}

type PatternAnalyzer = typeof checkSync;
type PatternSafetyControl = number | PatternAnalyzer;

/**
 * Classify a regex with `recheck` and reject genuinely dangerous shapes
 * (exponential, or polynomial degree > 2). Quadratic patterns like
 * `meeting.*tomorrow` stay allowed so we don't nerf realistic queries.
 */
export function checkPatternSafety(
  source: string,
  flags: string,
  control: PatternSafetyControl = RECHECK_TIMEOUT_MS
): PatternSafety {
  if (source.length > MAX_PATTERN_LENGTH) {
    return {
      ok: false,
      reason: `Pattern too long (${source.length} chars, max ${MAX_PATTERN_LENGTH}).`,
    };
  }
  const analyze = typeof control === 'function' ? control : checkSync;
  const timeoutMs = typeof control === 'number' ? control : RECHECK_TIMEOUT_MS;
  // An explicitly supplied analyzer is a test seam for fail-closed behavior,
  // so it must run even when the pattern is in the locally proven subset.
  if (
    typeof control !== 'function' &&
    typeof flags === 'string' &&
    (isClearlyLinearPattern(source) || isClearlyAtMostQuadraticPattern(source, flags))
  ) {
    return { ok: true };
  }
  // Retries share one wall-clock deadline. Each checkSync invocation otherwise
  // starts a fresh timeout, which would multiply request-path latency by the
  // retry count under load.
  const deadlineAt = Date.now() + timeoutMs;
  const runAnalyzer = () => {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) return null;
    try {
      return analyze(source, flags, { timeout: remainingMs });
    } catch {
      return null;
    }
  };
  // Two retries absorb a load-induced analyzer timeout without raising the
  // shared deadline or accepting an unclassified pattern. A third unknown
  // still fail-closes — the guard exists to keep catastrophic regex out of
  // Postgres.
  let diagnostics = runAnalyzer();
  if (diagnostics === null || diagnostics.status === 'unknown') {
    diagnostics = runAnalyzer();
  }
  if (diagnostics === null || diagnostics.status === 'unknown') {
    diagnostics = runAnalyzer();
  }
  if (diagnostics === null || diagnostics.status === 'unknown') {
    return unclassifiedPatternRejection();
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

/**
 * Patterns are validated as JS RegExp but run as Postgres ARE, where `\b` is a
 * backspace and `\B` a synonym for `\`. ARE's `\y` / `\Y` use locale-aware
 * word characters, whereas JS (without Unicode mode) uses ASCII letters,
 * digits and underscore. Express the adjacent-character transition explicitly;
 * both alternatives are zero-width, including at either end of the string.
 * Spell out class members so locale-dependent ranges cannot include accented
 * letters. Escaped backslashes and `[\b]` are left alone.
 */
export function translateWordBoundaries(pattern: string): string {
  const word = '[ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_]';
  const boundary = `(?:(?<!${word})(?=${word})|(?<=${word})(?!${word}))`;
  const nonBoundary = `(?:(?<=${word})(?=${word})|(?<!${word})(?!${word}))`;
  let out = '';
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      out +=
        !inClass && next === 'b' ? boundary : !inClass && next === 'B' ? nonBoundary : ch + next;
      i++;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    out += ch;
  }
  return out;
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
