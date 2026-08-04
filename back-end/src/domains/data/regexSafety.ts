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

interface ProvenCharacterSet {
  ascii: Set<number>;
  hasNonAsciiWord: boolean;
  hasNonAsciiWhitespace: boolean;
  unknown: boolean;
}

interface ParsedAtom {
  end: number;
  characters: ProvenCharacterSet;
  mayRepeatWithoutAnalyzer: boolean;
  zeroWidth?: boolean;
}

interface ParsedQuantifier {
  end: number;
  minimum: number;
  maximum: number | null;
}

const MAX_LOCAL_BOUNDED_REPETITION = 1000;
const MAX_LOCAL_VARIABLE_BOUNDED_REPETITION = 5;
const MAX_LOCAL_VARIABLE_BOUNDED_ATOMS = 2;

function emptyCharacterSet(): ProvenCharacterSet {
  return {
    ascii: new Set<number>(),
    hasNonAsciiWord: false,
    hasNonAsciiWhitespace: false,
    unknown: false,
  };
}

function addAscii(set: ProvenCharacterSet, code: number, caseInsensitive: boolean): void {
  set.ascii.add(code);
  if (!caseInsensitive) return;
  if (code >= 65 && code <= 90) set.ascii.add(code + 32);
  if (code >= 97 && code <= 122) set.ascii.add(code - 32);
}

function addCharacterClassEscape(
  set: ProvenCharacterSet,
  escaped: string,
  caseInsensitive: boolean
): boolean {
  if (escaped === 'd') {
    for (let code = 48; code <= 57; code += 1) addAscii(set, code, caseInsensitive);
    return true;
  }
  if (escaped === 'w') {
    for (let code = 48; code <= 57; code += 1) addAscii(set, code, caseInsensitive);
    for (let code = 65; code <= 90; code += 1) addAscii(set, code, caseInsensitive);
    for (let code = 97; code <= 122; code += 1) addAscii(set, code, caseInsensitive);
    addAscii(set, 95, caseInsensitive);
    set.hasNonAsciiWord = true;
    return true;
  }
  if (escaped === 's') {
    for (const code of [9, 10, 11, 12, 13, 32]) addAscii(set, code, caseInsensitive);
    set.hasNonAsciiWhitespace = true;
    return true;
  }
  return false;
}

function parseCharacterClass(
  source: string,
  start: number,
  caseInsensitive: boolean
): ParsedAtom | null {
  let close = start + 1;
  for (; close < source.length; close += 1) {
    if (source[close] === '\\') close += 1;
    else if (source[close] === ']') break;
  }
  if (close >= source.length || close === start + 1 || source[start + 1] === '^') return null;

  const characters = emptyCharacterSet();
  const body = source.slice(start + 1, close);
  if (body === '0-9' || body === '0-9,') {
    for (let code = 48; code <= 57; code += 1) addAscii(characters, code, caseInsensitive);
    if (body.endsWith(',')) addAscii(characters, 44, caseInsensitive);
  } else if (body === 'A-Z') {
    for (let code = 65; code <= 90; code += 1) addAscii(characters, code, caseInsensitive);
  } else if (body === '\\w.') {
    addCharacterClassEscape(characters, 'w', caseInsensitive);
    addAscii(characters, 46, caseInsensitive);
  } else {
    return null;
  }
  return { end: close, characters, mayRepeatWithoutAnalyzer: true };
}

function parseQuantifier(source: string, start: number): ParsedQuantifier | null | false {
  const char = source[start];
  let quantifier: ParsedQuantifier | null = null;
  if (char === '*') quantifier = { end: start, minimum: 0, maximum: null };
  else if (char === '+') quantifier = { end: start, minimum: 1, maximum: null };
  else if (char === '?') quantifier = { end: start, minimum: 0, maximum: 1 };
  else if (char === '{') {
    const close = source.indexOf('}', start + 1);
    if (close === -1) return false;
    const match = /^(\d+)(?:,(\d*))?$/.exec(source.slice(start + 1, close));
    if (match === null) return false;
    const minimum = Number(match[1]);
    const maximum = match[2] === undefined ? minimum : match[2] === '' ? null : Number(match[2]);
    if (
      !Number.isSafeInteger(minimum) ||
      (maximum !== null && (!Number.isSafeInteger(maximum) || maximum < minimum)) ||
      minimum > MAX_LOCAL_BOUNDED_REPETITION ||
      (maximum !== null && maximum > MAX_LOCAL_BOUNDED_REPETITION)
    ) {
      return false;
    }
    quantifier = { end: close, minimum, maximum };
  }
  if (quantifier !== null && source[quantifier.end + 1] === '?') quantifier.end += 1;
  return quantifier;
}

function parseAtom(source: string, start: number, caseInsensitive: boolean): ParsedAtom | null {
  const char = source[start];
  if (char === '[') return parseCharacterClass(source, start, caseInsensitive);
  if (char === '\\') {
    const escaped = source[start + 1];
    if (escaped === undefined) return null;
    if (escaped === 'b' || escaped === 'B') {
      return {
        end: start + 1,
        characters: emptyCharacterSet(),
        mayRepeatWithoutAnalyzer: false,
        zeroWidth: true,
      };
    }
    const characters = emptyCharacterSet();
    if (addCharacterClassEscape(characters, escaped, caseInsensitive)) {
      return { end: start + 1, characters, mayRepeatWithoutAnalyzer: true };
    }
    // Keep backreferences and multi-character/property escapes analyzer-owned.
    if (/^[A-Za-z0-9]$/.test(escaped)) return null;
    addAscii(characters, escaped.charCodeAt(0), caseInsensitive);
    return { end: start + 1, characters, mayRepeatWithoutAnalyzer: false };
  }
  if (char === '.') {
    const characters = emptyCharacterSet();
    characters.unknown = true;
    return { end: start, characters, mayRepeatWithoutAnalyzer: false };
  }
  if ('*+?{}()|^$'.includes(char)) return null;
  const characters = emptyCharacterSet();
  const code = source.charCodeAt(start);
  if (code <= 127) addAscii(characters, code, caseInsensitive);
  else characters.unknown = true;
  return { end: start, characters, mayRepeatWithoutAnalyzer: false };
}

function parseFiniteGroup(
  source: string,
  start: number,
  caseInsensitive: boolean
): { end: number; hasAlternation: boolean } | null {
  if (source[start + 1] === '?') return null;
  let branchHasAtom = false;
  let hasAlternation = false;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === ')') {
      return branchHasAtom ? { end: index, hasAlternation } : null;
    }
    if (source[index] === '|') {
      if (!branchHasAtom) return null;
      branchHasAtom = false;
      hasAlternation = true;
      continue;
    }
    if (source[index] === '(' || source[index] === '^' || source[index] === '$') return null;
    const atom = parseAtom(source, index, caseInsensitive);
    if (atom === null || atom.zeroWidth) return null;
    const quantifier = parseQuantifier(source, atom.end + 1);
    if (
      quantifier === false ||
      (quantifier !== null && quantifier.maximum !== quantifier.minimum)
    ) {
      return null;
    }
    index = quantifier?.end ?? atom.end;
    branchHasAtom = true;
  }
  return null;
}

function setsAreProvablyDisjoint(left: ProvenCharacterSet, right: ProvenCharacterSet): boolean {
  if (left.unknown || right.unknown) return false;
  for (const code of left.ascii) if (right.ascii.has(code)) return false;
  if (left.hasNonAsciiWord && right.hasNonAsciiWord) return false;
  if (left.hasNonAsciiWhitespace && right.hasNonAsciiWhitespace) return false;
  return true;
}

/**
 * Prove a deliberately narrow grammar has polynomial degree at most two.
 * Unbounded repetition is allowed only for one-character positive classes.
 * Every later repetition must be disjoint from the previous one or separated
 * by a mandatory character disjoint from both. This prevents the overlapping
 * repetition chains that raise the backtracking degree. Quantified alternation,
 * repeated groups, wildcard repetition, backreferences, and lookarounds remain
 * analyzer-owned.
 */
function isClearlyAtMostQuadraticPattern(source: string, flags: string): boolean {
  if (!/^[ims]*$/.test(flags)) return false;
  const caseInsensitive = flags.includes('i');
  let optionalConstructCount = 0;
  let variableBoundedAtomCount = 0;
  let finiteGroupCount = 0;
  let optionalGroupSeen = false;
  let repetitionFrontiers: Array<{
    characters: ProvenCharacterSet;
    mandatorySeparators: ProvenCharacterSet[];
  }> = [];

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '^' || char === '$') continue;
    if (char === '(') {
      const group = parseFiniteGroup(source, index, caseInsensitive);
      if (group === null) return false;
      finiteGroupCount += 1;
      if (finiteGroupCount > 1) return false;
      const quantifier = parseQuantifier(source, group.end + 1);
      // Only a non-alternating finite group may be optional. All other group
      // quantification is deliberately delegated to recheck.
      if (
        quantifier === false ||
        (quantifier !== null &&
          (group.hasAlternation || quantifier.minimum !== 0 || quantifier.maximum !== 1))
      ) {
        return false;
      }
      if (quantifier !== null) {
        optionalConstructCount += 1;
        if (optionalConstructCount > 1) return false;
        optionalGroupSeen = true;
      }
      index = quantifier?.end ?? group.end;
      continue;
    }

    const atom = parseAtom(source, index, caseInsensitive);
    if (atom === null) return false;
    const quantifier = parseQuantifier(source, atom.end + 1);
    if (quantifier === false || (atom.zeroWidth === true && quantifier !== null)) return false;
    index = quantifier?.end ?? atom.end;

    const isVariableRepetition =
      quantifier?.maximum === null ||
      (quantifier !== null && quantifier.maximum !== quantifier.minimum);
    if (isVariableRepetition) {
      if (quantifier?.maximum !== null) {
        variableBoundedAtomCount += 1;
        if (variableBoundedAtomCount > MAX_LOCAL_VARIABLE_BOUNDED_ATOMS) return false;
      }
      if (
        quantifier?.maximum !== null &&
        quantifier.maximum > MAX_LOCAL_VARIABLE_BOUNDED_REPETITION
      ) {
        return false;
      }
      const isSingleOptional = quantifier?.minimum === 0 && quantifier.maximum === 1;
      if ((!atom.mayRepeatWithoutAnalyzer && !isSingleOptional) || optionalGroupSeen) return false;
      if (quantifier?.minimum === 0) {
        optionalConstructCount += 1;
        if (optionalConstructCount > 1) return false;
      }
      for (const frontier of repetitionFrontiers) {
        const separated =
          setsAreProvablyDisjoint(frontier.characters, atom.characters) ||
          frontier.mandatorySeparators.some(
            (separator) =>
              setsAreProvablyDisjoint(frontier.characters, separator) &&
              setsAreProvablyDisjoint(separator, atom.characters)
          );
        if (!separated) return false;
      }
      const currentFrontier = { characters: atom.characters, mandatorySeparators: [] };
      repetitionFrontiers =
        quantifier?.minimum === 0 ? [...repetitionFrontiers, currentFrontier] : [currentFrontier];
    } else if (atom.zeroWidth !== true && (quantifier?.minimum ?? 1) > 0) {
      for (const frontier of repetitionFrontiers) {
        frontier.mandatorySeparators.push(atom.characters);
      }
    }
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
  let diagnostics;
  try {
    diagnostics = analyze(source, flags, { timeout: timeoutMs });
  } catch {
    // A timeout is most likely for the complex patterns this guard exists to
    // stop, especially when the host is under load. Never let an unclassified
    // pattern reach Postgres's backtracking regex engine.
    return unclassifiedPatternRejection();
  }
  if (diagnostics.status === 'unknown') return unclassifiedPatternRejection();
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
