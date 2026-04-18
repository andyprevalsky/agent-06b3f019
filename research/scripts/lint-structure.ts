#!/usr/bin/env tsx
/**
 * Structural lint checks for strict-domain TypeScript files.
 *
 * Enforces:
 *   - Max 300 meaningful lines per file (skips blank lines and comments)
 *   - Max 80 meaningful lines per function/method
 *
 * Reads the strict file list from deno-strict.json so the same source of truth
 * controls both deno-lint strict rules and structural limits.
 *
 * Usage:
 *   npx tsx research/scripts/lint-structure.ts          # check all strict files
 *   npx tsx research/scripts/lint-structure.ts <file>   # check a single file
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import process from 'node:process';

const RESEARCH = resolve(dirname(new URL(import.meta.url).pathname), '..');
const MAX_FILE_LINES = 300;
const MAX_FUNCTION_LINES = 80;

// Pre-existing oversized files awaiting further decomposition. These were
// ratcheted in before structural checks ran and should be split as follow-up
// work; skipping here keeps the ratchet from going backwards.
const SKIP_FILES = new Set<string>([
  'domains/completions/service/anthropic.ts',
  'domains/completions/service/browser-use-native.ts',
  'domains/completions/service/generic.ts',
  'domains/completions/service/streaming.ts',
  'domains/completions/service/racing.ts',
  'domains/completions/service/browser-use.ts',
  'domains/completions/service/claude-token.ts',
  'domains/completions/service/cot.ts',
  'domains/completions/service/trio-stream.ts',
  'domains/completions/service/handler.ts',
]);

interface Violation {
  file: string;
  message: string;
}

/** Count meaningful lines (skip blank lines and single-line comments). */
function countMeaningfulLines(lines: string[]): number {
  let count = 0;
  let inBlockComment = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    count++;
  }
  return count;
}

// Patterns that identify a function declaration/expression opening.
const FUNC_PATTERNS = [
  /(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
  /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/,
  /(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/,
];

/** Find functions and count their meaningful line lengths. */
function checkFunctionLengths(
  filePath: string,
  lines: string[],
): Violation[] {
  const violations: Violation[] = [];
  const funcStack: { name: string; startLine: number; braceDepth: number; lines: string[] }[] = [];
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comments and blank lines for detection (countMeaningfulLines
    // handles these correctly when scoring the collected function lines).
    if (
      trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') ||
      trimmed.startsWith('*')
    ) {
      continue;
    }

    // Check for function start
    if (trimmed.includes('{')) {
      let funcName: string | null = null;
      for (const pattern of FUNC_PATTERNS) {
        const match = trimmed.match(pattern);
        if (match) {
          funcName = match[1];
          break;
        }
      }
      if (
        funcName &&
        (trimmed.includes('function') || trimmed.includes('=>') ||
          trimmed.match(/\)\s*(?::\s*[^{]+)?\s*\{/))
      ) {
        funcStack.push({ name: funcName, startLine: i + 1, braceDepth, lines: [] });
      }
    }

    // Track brace depth
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth--;
    }

    // Add line to current function
    if (funcStack.length > 0) {
      funcStack[funcStack.length - 1].lines.push(line);
    }

    // Check if any function closed
    while (funcStack.length > 0 && braceDepth <= funcStack[funcStack.length - 1].braceDepth) {
      const func = funcStack.pop()!;
      const meaningful = countMeaningfulLines(func.lines);
      if (meaningful > MAX_FUNCTION_LINES) {
        violations.push({
          file: filePath,
          message:
            `Function "${func.name}" (line ${func.startLine}) has ${meaningful} meaningful lines (max ${MAX_FUNCTION_LINES})`,
        });
      }
    }
  }

  return violations;
}

function checkFile(relPath: string): Violation[] {
  if (SKIP_FILES.has(relPath)) return [];
  const absPath = resolve(RESEARCH, relPath);
  if (!existsSync(absPath)) {
    return [{ file: relPath, message: `File not found: ${absPath}` }];
  }

  const content = readFileSync(absPath, 'utf-8');
  const lines = content.split('\n');
  const violations: Violation[] = [];

  // Check file length
  const meaningful = countMeaningfulLines(lines);
  if (meaningful > MAX_FILE_LINES) {
    violations.push({
      file: relPath,
      message: `File has ${meaningful} meaningful lines (max ${MAX_FILE_LINES})`,
    });
  }

  // Check function lengths
  violations.push(...checkFunctionLengths(relPath, lines));

  return violations;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const singleFile = process.argv[2];

let files: string[];
if (singleFile) {
  files = [singleFile];
} else {
  // Read from deno-strict.json
  const strictConfig = JSON.parse(readFileSync(resolve(RESEARCH, 'deno-strict.json'), 'utf-8'));
  files = strictConfig.lint?.include ?? [];
}

const allViolations: Violation[] = [];
for (const file of files) {
  allViolations.push(...checkFile(file));
}

if (allViolations.length > 0) {
  console.error(`\nStructural lint violations (${allViolations.length}):\n`);
  for (const v of allViolations) {
    console.error(`  ${v.file}: ${v.message}`);
  }
  console.error('');
  process.exit(1);
} else {
  console.log(`Structural lint OK (${files.length} files checked)`);
}
