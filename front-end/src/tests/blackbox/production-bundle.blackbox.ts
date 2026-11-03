import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const frontendRoot = resolve(process.cwd());
const guard = join(frontendRoot, 'scripts/assert-production-bundle.mjs');
const animationFiles = [
  'src/lib/animation-1-pixels.json',
  'src/lib/animation-2-pixels.json',
  'src/lib/animation-3-pixels.json',
  'src/lib/animation-4-pixels.json',
  'src/features/terminal-component-group/components/ascii-frames.json',
  'src/features/terminal-component-group/components/ascii-frames-engine.json',
];
const payloadCalls = animationFiles.map(
  (file) => `JSON.parse(${JSON.stringify(readFileSync(join(frontendRoot, file), 'utf8'))});`,
);
const fixtureDirectories: string[] = [];
const invalidUnicodeComment = String.raw`// JSON.parse('\u{xyz}')`;

function runGuard(
  calls: readonly string[],
  incidentalText = '',
  startup: 'dynamic' | 'static' | 'missing-manifest' = 'dynamic',
) {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'rose-production-bundle-'));
  fixtureDirectories.push(outputDirectory);
  mkdirSync(join(outputDirectory, 'assets'));
  const source = `${calls.join('\n')}\n${incidentalText}\n`;
  const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: source,
    encoding: 'utf8',
  });
  expect(syntax.status, syntax.stderr).toBe(0);
  writeFileSync(join(outputDirectory, 'assets', 'animation-fixture.js'), source);
  writeFileSync(join(outputDirectory, 'assets', 'main.js'), 'export {};');
  writeFileSync(
    join(outputDirectory, 'index.html'),
    '<script type="module" src="/assets/main.js"></script>',
  );
  if (startup !== 'missing-manifest') {
    mkdirSync(join(outputDirectory, '.vite'));
    writeFileSync(
      join(outputDirectory, '.vite', 'manifest.json'),
      JSON.stringify({
        'src/main.tsx': {
          file: 'assets/main.js',
          isEntry: true,
          [startup === 'static' ? 'imports' : 'dynamicImports']: ['animations'],
        },
        animations: { file: 'assets/animation-fixture.js', isDynamicEntry: true },
      }),
    );
  }

  return spawnSync(process.execPath, [guard, outputDirectory], { encoding: 'utf8' });
}

describe('production bundle validation', () => {
  it('keeps desktop animation payloads out of the synchronous app startup graph', () => {
    const result = runGuard(payloadCalls, '', 'static');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Desktop animation payload must be deferred from app startup');
  });
  it('requires the manifest needed to verify startup dependencies', () => {
    const result = runGuard(payloadCalls, '', 'missing-manifest');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Production startup manifest is required');
  });

  afterEach(() => {
    for (const directory of fixtureDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('accepts all six unchanged animation payloads', () => {
    const result = runGuard(payloadCalls);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Production animation payloads preserve every frame');
  });

  it.each([
    ['invalid Unicode escape in a comment', invalidUnicodeComment],
    ['unterminated call text in a comment', "// JSON.parse('unterminated"],
    ['unterminated call text in a string', `const note = "JSON.parse('unterminated";`],
  ] as const)('ignores unrelated %s while enforcing payload preservation', (_name, text) => {
    const result = runGuard(payloadCalls, text);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Production animation payloads preserve every frame');
  });

  it.each([
    ['missing', payloadCalls.slice(1)],
    ['mutated', ['JSON.parse("{}");', ...payloadCalls.slice(1)]],
  ] as const)(
    'rejects a %s required payload even beside unrelated malformed text',
    (_name, calls) => {
      const result = runGuard(calls, invalidUnicodeComment);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'Production bundle must preserve animation-1-pixels.json as an identical JSON.parse payload',
      );
    },
  );

  it('still rejects the React Grab development runtime', () => {
    const result = runGuard(payloadCalls, 'const developmentRuntime = "react-grab.com";');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Production bundle contains the React Grab development runtime',
    );
  });
});
