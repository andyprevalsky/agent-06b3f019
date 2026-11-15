#!/usr/bin/env tsx
/**
 * Structural guard (V2/V3): every backend Rose completion caller archives its
 * call under a REAL root. A caller that omits dump_context is never archived;
 * one that omits the root is refused by the writer (llm.archive.unbound_root_refused).
 *
 *   createStreamingCompletion caller ─► dump_context { call_site, root_agent_id | archive_scope }
 *                                        root = busId ?? id   (rootOf, or archive_scope resolved
 *                                             | user-<userId>  by the writer off the call path)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../..');
const EXCLUDED_DIRS = [path.join(SRC, 'tests'), path.join(SRC, 'providers', 'rose')];
/** Root binding forms accepted inside a dump_context block. */
const ROOT_BINDINGS = [/root_agent_id\s*:/, /archive_scope\s*:/, /\.\.\.opts\.archive\b/];

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return EXCLUDED_DIRS.includes(full) ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Balanced `{...}` following `dump_context:` (or null when it is not an object literal). */
function dumpContextBlocks(source: string): string[] {
  const blocks: string[] = [];
  for (const match of source.matchAll(/dump_context:\s*/g)) {
    let index = (match.index ?? 0) + match[0].length;
    if (source[index] === '(' || source[index] === '?') {
      // conditional spread forms: take the rest of the expression line-block
      const end = source.indexOf('\n\n', index);
      blocks.push(source.slice(index, end === -1 ? undefined : end));
      continue;
    }
    if (source[index] !== '{') {
      blocks.push(source.slice(index, source.indexOf('\n', index)));
      continue;
    }
    let depth = 0;
    const start = index;
    for (; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}') depth -= 1;
      if (depth === 0) break;
    }
    blocks.push(source.slice(start, index + 1));
  }
  return blocks;
}

/** Files that INVOKE a Rose completion (direct, or through an injected completion fn). */
const callers = sourceFiles(SRC).filter((file) => {
  const source = fs.readFileSync(file, 'utf8');
  return (
    /\bcreateStreamingCompletion\b/.test(source) &&
    /\b(createStreamingCompletion|streamCompletion)\s*\(|\bcomplete\(\{/.test(source)
  );
});

const failures: string[] = [];
for (const file of callers) {
  const relative = path.relative(SRC, file);
  const source = fs.readFileSync(file, 'utf8');
  const blocks = dumpContextBlocks(source);
  if (blocks.length === 0) {
    failures.push(`${relative}: calls createStreamingCompletion without a dump_context`);
    continue;
  }
  for (const block of blocks) {
    if (!ROOT_BINDINGS.some((pattern) => pattern.test(block))) {
      failures.push(`${relative}: dump_context without a root binding: ${block.slice(0, 160)}`);
    }
  }
}

// The call sites this guard exists for must stay inside it.
for (const required of [
  'providers/setResponseSchema.ts',
  'providers/phoneAuthLoss.ts',
  'providers/phoneSetupVerifier.ts',
  'providers/phoneMessageVerifier.ts',
  'providers/phoneCredentialVerifier.ts',
  'providers/credentialPropagationClassifier.ts',
  'providers/browser/challengeLlmClassifier.ts',
  'providers/smsSupervisor/supervisorLlm.ts',
  'providers/smsSupervisor/notificationLlm.ts',
  'domains/purchases/approvalReuse.ts',
  'domains/vapi/holdDetectorService.ts',
  'providers/chat/routerLlm.ts',
  'providers/chat/generatorLlm.ts',
  'providers/chat/chatCompaction.ts',
  'domains/credential-propagation/classifier.ts',
]) {
  if (!callers.some((file) => path.relative(SRC, file) === required)) {
    failures.push(`${required}: expected Rose completion caller not found (renamed? update guard)`);
  }
}

// Root lookups never run before the model call: pass archive_scope instead.
for (const file of sourceFiles(SRC)) {
  if (/await\s+archiveBindingFor\(/.test(fs.readFileSync(file, 'utf8'))) {
    failures.push(`${path.relative(SRC, file)}: awaits archiveBindingFor on the call path`);
  }
}

assert.deepEqual(failures, [], failures.join('\n'));
process.stdout.write(
  `llm-archive-call-sites: ${callers.length} completion callers bind an archive root\n`
);
