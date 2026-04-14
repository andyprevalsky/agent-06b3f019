/**
 * Structural dependency test — validates import direction rules for ALL feature domains.
 *
 * Auto-discovers every directory under src/features/ and verifies that each layer
 * only imports from permitted layers (forward-only, never reverse).
 *
 * Import direction rules (frontend):
 *   types.ts      → external packages + shared/types/ only
 *   config.ts     → own types only (from project)
 *   api.ts        → own types, own config, shared/lib/
 *   hooks.ts      → own api, own types, own config, shared/*
 *   components/*  → own hooks, own types, own config, shared/*, external packages
 *   index.ts      → re-exports from own layers only
 *
 * Cross-domain imports are NEVER allowed (features must not import from other features).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ─── Helpers ───────────────────────────────────────────────────────────────

const SRC_DIR = path.resolve(__dirname, '../..');
const FEATURES_DIR = path.join(SRC_DIR, 'features');

/** Extract all import/require paths from a TypeScript/TSX source file. */
function extractImports(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const imports: string[] = [];

  // Static imports: import ... from '...'
  const staticRe = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = staticRe.exec(content)) !== null) {
    imports.push(match[1]);
  }

  // Dynamic imports: import('...')
  const dynamicRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicRe.exec(content)) !== null) {
    imports.push(match[1]);
  }

  // require('...')
  const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRe.exec(content)) !== null) {
    imports.push(match[1]);
  }

  return imports;
}

/** Check if an import is a project-local import (starts with ./ or ../ or @/). */
function isProjectImport(importPath: string): boolean {
  return importPath.startsWith('./') || importPath.startsWith('../') || importPath.startsWith('@/');
}

/** Resolve an import path relative to the importing file, returning a path relative to src/. */
function resolveImport(importPath: string, fromFile: string): string {
  if (importPath.startsWith('@/')) {
    return importPath.replace('@/', '');
  }
  const fromDir = path.dirname(fromFile);
  const resolved = path.normalize(path.join(fromDir, importPath));
  const relative = path.relative(SRC_DIR, resolved);
  return relative;
}

/** Get all .ts/.tsx files recursively in a directory. */
function getFiles(dir: string, ext: string[] = ['.ts', '.tsx']): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getFiles(full, ext));
    } else if (ext.some((e) => entry.name.endsWith(e))) {
      results.push(full);
    }
  }
  return results;
}

/** Classify a file into its layer within a feature domain. */
function classifyLayer(
  filePath: string,
  featureName: string,
): 'types' | 'config' | 'api' | 'hooks' | 'components' | 'index' | 'unknown' {
  const rel = path.relative(path.join(FEATURES_DIR, featureName), filePath);
  if (rel === 'types.ts') return 'types';
  if (rel === 'config.ts') return 'config';
  if (rel === 'api.ts') return 'api';
  if (rel === 'hooks.ts') return 'hooks';
  if (rel.startsWith('hooks/') || rel.startsWith('hooks\\')) return 'hooks';
  if (rel === 'index.ts') return 'index';
  if (rel.startsWith('components/') || rel.startsWith('components\\')) return 'components';
  return 'unknown';
}

/** Check if a resolved import targets a specific layer within the same domain. */
function targetsOwnLayer(resolvedImport: string, featureName: string, layer: string): boolean {
  const prefix = `features/${featureName}/`;
  if (!resolvedImport.startsWith(prefix)) return false;
  const rest = resolvedImport.slice(prefix.length);
  if (layer === 'components') return rest.startsWith('components');
  return rest === layer || rest.startsWith(layer + '/');
}

/** Check if a resolved import targets any feature domain. */
function targetsAnyFeature(resolvedImport: string): string | null {
  const match = resolvedImport.match(/^features\/([^/]+)/);
  return match ? match[1] : null;
}

// ─── Layer-specific allowed own-layer imports ─────────────────────────────

type Layer = 'types' | 'config' | 'api' | 'hooks' | 'components' | 'index';

const ALLOWED_OWN_LAYERS: Record<Layer, Layer[]> = {
  types: [],
  config: ['types'],
  api: ['types', 'config'],
  hooks: ['api', 'types', 'config', 'hooks'],
  components: ['hooks', 'types', 'config', 'components'],
  index: ['types', 'config', 'api', 'hooks', 'components'],
};

// ─── Known pre-existing violations (legacy, to be fixed per-domain) ───────
// Key: relative path from src/. Value: array of violation message prefixes to skip.
const KNOWN_VIOLATIONS: Record<string, string[]> = {
  'features/settings/hooks.ts': ['Cross-domain import: "@/features/customization"'],
  'features/settings/hooks/useSaveCustomization.ts': ['Cross-domain import: "@/features/customization"'],
  'features/settings/hooks/useSettingsData.ts': ['Cross-domain import: "@/features/customization"'],
  'features/settings/components/Settings.tsx': ['Cross-domain import: "@/features/customization"'],
  'features/settings/components/CustomizationTab.tsx': ['Cross-domain import: "@/features/customization"'],
  'features/settings/components/SettingsTabContent.tsx': ['Cross-domain import: "@/features/customization"'],
  'features/terminal/components/TerminalModals.tsx': [
    'Cross-domain import: "@/features/auth"',
    'Cross-domain import: "@/features/terminal-component-group"',
  ],
  'features/terminal/components/AgentChatArea.tsx': ['Cross-domain import: "@/features/terminal-component-group"'],
  'features/terminal/components/BackgroundPattern.tsx': ['Cross-domain import: "@/features/terminal-component-group"'],
  'features/terminal/components/TerminalContent.tsx': [
    'Cross-domain import: "@/features/terminal-component-group"',
    'Cross-domain import: "@/features/terminal-component-group/',
  ],
  'features/terminal/components/TerminalHeader.tsx': ['Cross-domain import: "@/features/terminal-component-group"'],
  // blog is a shared component/data library consumed by research-blog and research-blog-post
  'features/research-blog/hooks.ts': ['Cross-domain import: "@/features/blog"'],
  'features/research-blog/components/ResearchBlog.tsx': ['Cross-domain import: "@/features/blog"'],
  'features/research-blog-post/api.ts': ['Cross-domain import: "@/features/blog"'],
  'features/research-blog-post/components/ResearchBlogPost.tsx': ['Cross-domain import: "@/features/blog"'],
};

// ─── Test ──────────────────────────────────────────────────────────────────

describe('Structural dependency rules', () => {
  const featureNames = fs
    .readdirSync(FEATURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  it('discovers at least one feature domain', () => {
    expect(featureNames.length).toBeGreaterThan(0);
  });

  for (const featureName of featureNames) {
    describe(`features/${featureName}`, () => {
      const featureDir = path.join(FEATURES_DIR, featureName);
      const allFiles = getFiles(featureDir);

      for (const filePath of allFiles) {
        const layer = classifyLayer(filePath, featureName);
        if (layer === 'unknown') continue;

        const relPath = path.relative(SRC_DIR, filePath);

        it(`${relPath} follows import direction rules`, () => {
          const imports = extractImports(filePath);
          const violations: string[] = [];

          for (const imp of imports) {
            if (!isProjectImport(imp)) continue;

            const resolved = resolveImport(imp, filePath);

            // Rule 1: No cross-domain imports
            // Exception: app-wiring is the routing coordination layer and must
            // import all feature entry points to wire the route table.
            const targetFeature = targetsAnyFeature(resolved);
            if (targetFeature && targetFeature !== featureName && featureName !== 'app-wiring') {
              violations.push(
                `Cross-domain import: "${imp}" → features/${targetFeature} (from ${layer} layer)`,
              );
              continue;
            }

            // Rule 2: Only allowed own-layer imports
            if (targetFeature === featureName) {
              const allowedLayers = ALLOWED_OWN_LAYERS[layer as Layer] || [];
              const isAllowed = allowedLayers.some((allowedLayer) =>
                targetsOwnLayer(resolved, featureName, allowedLayer),
              );
              // index.ts can re-export from any own layer
              if (layer === 'index') continue;
              // components/index.ts and hooks/index.ts are barrels — always allowed
              const rel = path.relative(featureDir, filePath);
              if (rel === 'components/index.ts' || rel === 'hooks/index.ts') continue;

              if (!isAllowed) {
                violations.push(
                  `${layer} layer imports "${imp}" — only [${allowedLayers.join(', ')}] allowed`,
                );
              }
            }
          }

          // Filter out known pre-existing violations
          const knownForFile = KNOWN_VIOLATIONS[relPath] || [];
          const newViolations = violations.filter(
            (v) => !knownForFile.some((known) => v.startsWith(known)),
          );

          expect(newViolations).toEqual([]);
        });
      }
    });
  }
});
