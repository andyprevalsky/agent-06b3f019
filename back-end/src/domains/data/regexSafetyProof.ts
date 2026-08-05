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

interface RepetitionFrontier {
  characters: ProvenCharacterSet;
  mandatorySeparators: ProvenCharacterSet[];
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
  // Postgres resolves a bracket range like `0-9` against the active collation
  // rather than against ASCII code points, and no regex sink pins `COLLATE "C"`.
  // A range's true membership is therefore unprovable here, so fail closed by
  // marking it unknown: `setsAreProvablyDisjoint` then refuses to separate two
  // repetition frontiers on the strength of a range.
  const isCollationDependentRange = body.includes('-');
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
  if (isCollationDependentRange) characters.unknown = true;
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
    if (source[index] === ')') return branchHasAtom ? { end: index, hasAlternation } : null;
    if (source[index] === '|') {
      if (!branchHasAtom) return null;
      branchHasAtom = false;
      hasAlternation = true;
      continue;
    }
    if (source[index] === '(' || source[index] === '^' || source[index] === '$') return null;
    const atom = parseAtom(source, index, caseInsensitive);
    if (atom === null || atom.zeroWidth === true) return null;
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

function frontierIsSeparated(frontier: RepetitionFrontier, current: ProvenCharacterSet): boolean {
  return (
    setsAreProvablyDisjoint(frontier.characters, current) ||
    frontier.mandatorySeparators.some(
      (separator) =>
        setsAreProvablyDisjoint(frontier.characters, separator) &&
        setsAreProvablyDisjoint(separator, current)
    )
  );
}

/** Prove a narrow grammar has polynomial degree at most two. */
export function isClearlyAtMostQuadraticPattern(source: string, flags: string): boolean {
  if (!/^[ims]*$/.test(flags)) return false;
  const caseInsensitive = flags.includes('i');
  let optionalConstructCount = 0;
  let variableBoundedAtomCount = 0;
  let finiteGroupCount = 0;
  let optionalGroupSeen = false;
  let repetitionFrontiers: RepetitionFrontier[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '^' || char === '$') continue;
    if (char === '(') {
      const group = parseFiniteGroup(source, index, caseInsensitive);
      if (group === null) return false;
      finiteGroupCount += 1;
      if (finiteGroupCount > 1) return false;
      const quantifier = parseQuantifier(source, group.end + 1);
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
    const isVariable =
      quantifier?.maximum === null ||
      (quantifier !== null && quantifier.maximum !== quantifier.minimum);
    if (isVariable) {
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
      if (
        !repetitionFrontiers.every((frontier) => frontierIsSeparated(frontier, atom.characters))
      ) {
        return false;
      }
      const current = { characters: atom.characters, mandatorySeparators: [] };
      repetitionFrontiers =
        quantifier?.minimum === 0 ? [...repetitionFrontiers, current] : [current];
    } else if (atom.zeroWidth !== true && (quantifier?.minimum ?? 1) > 0) {
      for (const frontier of repetitionFrontiers) {
        frontier.mandatorySeparators.push(atom.characters);
      }
    }
  }
  return true;
}
