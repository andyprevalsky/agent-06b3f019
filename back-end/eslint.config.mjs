import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Domains under strict lint enforcement (type-aware rules, tighter limits).
 * The /setup-formatter-and-linter skill adds file paths here as domains are cleaned.
 * Paths are relative globs from back-end/.
 */
const STRICT_DOMAIN_FILES = [
  'src/domains/attention-requests/types.ts',
  'src/domains/attention-requests/config.ts',
  'src/domains/attention-requests/repo.ts',
  'src/domains/attention-requests/service.ts',
  'src/domains/attention-requests/routes.ts',
  'src/providers/credits.ts',
  'src/utils/log.ts',
  'src/providers/logger.ts',
  'src/providers/messages.ts',
  'src/providers/database.ts',
  'src/providers/auth.ts',
  'src/providers/hybridAuth.ts',
  'src/utils/asyncHandler.ts',
];

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },

  // ── Base config: all TypeScript files ──
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'max-lines': ['error', { max: 600, skipBlankLines: true, skipComments: true }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'no-duplicate-imports': 'error',
      'prefer-const': 'error',
    },
  },

  // ── Strict overlay: cleaned domains only (type-aware) ──
  ...(STRICT_DOMAIN_FILES.length > 0
    ? [
        {
          files: STRICT_DOMAIN_FILES,
          languageOptions: {
            parserOptions: {
              projectService: true,
              tsconfigRootDir: __dirname,
            },
          },
          rules: {
            'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
            'max-lines-per-function': [
              'error',
              { max: 80, skipBlankLines: true, skipComments: true },
            ],
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/strict-boolean-expressions': 'error',
            '@typescript-eslint/consistent-type-imports': [
              'error',
              { prefer: 'type-imports' },
            ],
          },
        },
      ]
    : []),

  // ── Ban .js files in src/ ──
  {
    files: ['src/**/*.{js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Program',
          message: 'JavaScript files are not allowed in src/. Use TypeScript (.ts/.tsx) instead.',
        },
      ],
    },
  },

  // ── Prettier compat (must be last — disables conflicting format rules) ──
  eslintConfigPrettier
);
