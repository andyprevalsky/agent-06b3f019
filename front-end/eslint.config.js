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
const LEGACY_STRICT_EXEMPT_FILES = [
  'src/components/auth/PhoneAuthModal.tsx',
  'src/components/customization/SystemCustomization.tsx',
  'src/contexts/AgentContext.tsx',
  'src/main.tsx',
  'src/pages/Integrations.tsx',
  'src/pages/OnePager.tsx',
  'src/pages/Privacy.tsx',
  'src/pages/Settings.tsx',
  'src/pages/Terminal.tsx',
  'src/pages/Terms.tsx',
  'src/pages/Usage.tsx',
];

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
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': 'off',
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

            // React-specific strict
            'react/no-unstable-nested-components': ['error', { allowAsProps: true }],
          },
        },
      ]
    : []),

  // ── Legacy strict exemptions (temporary, refactor targets) ─────────────
  ...(LEGACY_STRICT_EXEMPT_FILES.length > 0
    ? [
        {
          files: LEGACY_STRICT_EXEMPT_FILES,
          rules: {
            'max-lines': 'off',
            'max-lines-per-function': 'off',
            '@typescript-eslint/no-floating-promises': 'off',
            '@typescript-eslint/no-misused-promises': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            'no-console': 'off',
            'no-useless-catch': 'off',
          },
        },
      ]
    : []),

  // ── Storybook ──────────────────────────────────────────────────────────
  ...storybook.configs['flat/recommended'],

  // ── Prettier compat (must be last — disables conflicting format rules) ──
  eslintConfigPrettier,
);
