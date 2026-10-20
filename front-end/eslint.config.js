import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import react from 'eslint-plugin-react';
import tseslint from 'typescript-eslint';
import storybook from 'eslint-plugin-storybook';
import eslintConfigPrettier from 'eslint-config-prettier';

// ─── Dynamic domain discovery ───────────────────────────────────────────────
// Each domain has its own JSON file in eslint-strict-domains/ containing
// an array of file paths. Workers create these independently (no conflicts).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOMAINS_DIR = path.join(__dirname, 'eslint-strict-domains');

function loadStrictFiles() {
  if (!fs.existsSync(DOMAINS_DIR)) return [];

  const files = fs
    .readdirSync(DOMAINS_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'));

  const allPaths = [];
  for (const file of files) {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(DOMAINS_DIR, file), 'utf-8'));
      allPaths.push(...content);
    } catch (e) {
      console.warn(`[eslint] Failed to parse domain file: ${file}`, e.message);
    }
  }
  return [...new Set(allPaths)];
}

const strictFiles = loadStrictFiles();

// ─── Config ─────────────────────────────────────────────────────────────────
export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },

  // ── Base rules (all TS/TSX files) ──────────────────────────────────────
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      react,
    },
    // eslint-plugin-react otherwise warns "React version not specified" on every run.
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': 'off',
      // Base file-size ceiling for every TS/TSX file. The strict overlay below
      // tightens this to 300 for opted-in domains; blackbox/test suites can
      // opt out via a top-of-file `/* eslint-disable max-lines */`.
      'max-lines': ['error', { max: 600, skipBlankLines: true, skipComments: true }],
    },
  },

  // ── Strict overlay (only opted-in domain files) ────────────────────────
  ...(strictFiles.length > 0
    ? [
        {
          files: strictFiles,
          languageOptions: {
            parserOptions: {
              projectService: true,
              tsconfigRootDir: __dirname,
            },
          },
          plugins: {
            react,
          },
          rules: {
            // File & function size
            'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
            'max-lines-per-function': [
              'error',
              { max: 80, skipBlankLines: true, skipComments: true },
            ],

            // Async correctness
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',

            // Type safety
            '@typescript-eslint/consistent-type-imports': [
              'error',
              { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
            ],
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': [
              'error',
              { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],

            // No side-effect leaks
            'no-console': ['error', { allow: ['warn', 'error'] }],

            // Canonical utility enforcement
            'no-restricted-imports': [
              'error',
              {
                paths: [
                  {
                    name: '@amplitude/analytics-browser',
                    message: 'Import from @/lib/analytics instead of @amplitude/analytics-browser.',
                  },
                ],
              },
            ],
            'no-restricted-syntax': [
              'error',
              {
                selector:
                  "MemberExpression[object.name='localStorage'], MemberExpression[object.name='sessionStorage']",
                message:
                  'Use @/lib/storage (getItem/setItem/removeItem) instead of localStorage/sessionStorage directly.',
              },
              {
                selector:
                  "MemberExpression[object.type='MemberExpression'][object.object.name=/^(window|globalThis)$/][object.property.name=/^(localStorage|sessionStorage)$/]",
                message:
                  'Use @/lib/storage (getItem/setItem/removeItem) instead of window.localStorage / globalThis.localStorage.',
              },
              {
                selector: "CallExpression[callee.name='fetch']",
                message:
                  "Don't call fetch() directly in domain code. Put the call in the feature's api.ts layer.",
              },
              {
                selector:
                  "CallExpression[callee.type='MemberExpression'][callee.object.name=/^(window|globalThis)$/][callee.property.name='fetch']",
                message:
                  "Don't call window.fetch() / globalThis.fetch() directly in domain code. Put the call in the feature's api.ts layer.",
              },
              {
                selector:
                  "MemberExpression[object.type='MetaProperty'][object.meta.name='import'][object.property.name='meta'], MemberExpression[object.object.type='MetaProperty'][object.object.meta.name='import'][object.object.property.name='meta'][property.name='env']",
                message:
                  "Don't read import.meta.env in domain code. Centralize env access in the feature's config.ts.",
              },
              {
                selector:
                  "AssignmentExpression[left.type='MemberExpression'][left.object.name='document'][left.property.name='title']",
                message: 'Use useDocumentSeo from @/lib/seo instead of assigning document.title.',
              },
              {
                selector:
                  "AssignmentExpression[left.type='MemberExpression'][left.object.type='MemberExpression'][left.object.object.name=/^(window|globalThis)$/][left.object.property.name='document'][left.property.name='title']",
                message:
                  'Use useDocumentSeo from @/lib/seo instead of assigning window.document.title / globalThis.document.title.',
              },
              {
                selector:
                  "CallExpression[callee.object.name='document'][callee.property.name='createElement'][arguments.0.value=/^(meta|link)$/]",
                message:
                  'Use useDocumentSeo from @/lib/seo instead of creating meta/link tags directly.',
              },
              {
                selector:
                  "CallExpression[callee.type='MemberExpression'][callee.object.type='MemberExpression'][callee.object.object.name=/^(window|globalThis)$/][callee.object.property.name='document'][callee.property.name='createElement'][arguments.0.value=/^(meta|link)$/]",
                message:
                  'Use useDocumentSeo from @/lib/seo instead of creating meta/link tags via window.document / globalThis.document.',
              },
              {
                selector: "MemberExpression[object.name='navigator'][property.name='clipboard']",
                message:
                  'Use copyToClipboard from @/lib/clipboard instead of navigator.clipboard directly.',
              },
              {
                selector:
                  "MemberExpression[object.type='MemberExpression'][object.object.name=/^(window|globalThis)$/][object.property.name='navigator'][property.name='clipboard']",
                message:
                  'Use copyToClipboard from @/lib/clipboard instead of window.navigator.clipboard / globalThis.navigator.clipboard.',
              },
              {
                selector:
                  "NewExpression[callee.name='URLSearchParams'][arguments.0.type='MemberExpression'][arguments.0.object.property.name='location'][arguments.0.property.name='search']",
                message:
                  'Use getQueryParams from @/lib/url instead of `new URLSearchParams(window.location.search)`.',
              },
            ],

            // React-specific strict
            'react/no-unstable-nested-components': ['error', { allowAsProps: true }],
          },
        },
      ]
    : []),

  // ── Carve-outs for api.ts / config.ts (allowed to use fetch / import.meta.env) ──
  {
    files: ['src/features/**/api.ts', 'src/lib/api.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.name='localStorage'], MemberExpression[object.name='sessionStorage']",
          message:
            'Use @/lib/storage (getItem/setItem/removeItem) instead of localStorage/sessionStorage directly.',
        },
        {
          selector:
            "MemberExpression[object.type='MemberExpression'][object.object.name=/^(window|globalThis)$/][object.property.name=/^(localStorage|sessionStorage)$/]",
          message:
            'Use @/lib/storage (getItem/setItem/removeItem) instead of window.localStorage / globalThis.localStorage.',
        },
      ],
    },
  },
  {
    files: ['src/features/**/config.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  // ── Storybook ──────────────────────────────────────────────────────────
  ...storybook.configs['flat/recommended'],

  // ── Prettier compat (must be last — disables conflicting format rules) ──
  eslintConfigPrettier,
);
