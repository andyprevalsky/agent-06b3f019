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
  // ── All domain files (catches splits like routes.messages.ts, service.validation.ts, etc.) ──
  'src/domains/**/*.ts',
  // ── Shared providers and utils ──
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
  { ignores: ['dist', 'node_modules', 'scripts', 'coverage'] },

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

      // ── Canonical utility enforcement ──
      // Ban hand-rolled alternatives to shared utilities (OpenAI harness eng pattern).
      // See /enforce-canonical-utility skill and providers/retry.ts.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ForStatement:has(CallExpression[callee.name="setTimeout"])',
          message:
            'Hand-rolled retry loop detected. Use retryWithBackoff() or retryOnCollision() from providers/retry.ts instead.',
        },
        {
          selector: 'WhileStatement:has(CallExpression[callee.name="setTimeout"])',
          message:
            'Hand-rolled retry loop detected. Use retryWithBackoff() or retryOnCollision() from providers/retry.ts instead.',
        },
      ],
    },
  },

  // ── Test runners: console output IS the reporting surface ──
  // Blackbox and structural suites are CLI runners whose pass/fail output is
  // their product. Declared here so they never need an inline eslint-disable.
  {
    files: ['src/tests/blackbox/**/*.ts', 'src/tests/structural/**/*.ts'],
    rules: {
      'no-console': 'off',
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
            '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
          },
        },
      ]
    : []),

  // ── Domain non-config files: enforce config.ts pattern for env vars ──
  // process.env must only be read in config.ts; services/routes/repos import from config.ts.
  // NOTE: no-restricted-syntax must repeat base rules because flat-config replaces, not merges.
  {
    files: ['src/domains/**/*.ts'],
    ignores: ['src/domains/**/config.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ForStatement:has(CallExpression[callee.name="setTimeout"])',
          message:
            'Hand-rolled retry loop detected. Use retryWithBackoff() or retryOnCollision() from providers/retry.ts instead.',
        },
        {
          selector: 'WhileStatement:has(CallExpression[callee.name="setTimeout"])',
          message:
            'Hand-rolled retry loop detected. Use retryWithBackoff() or retryOnCollision() from providers/retry.ts instead.',
        },
        {
          selector: 'MemberExpression[object.object.name="process"][object.property.name="env"]',
          message:
            'Read process.env in your domain config.ts, not here. Import the value from config.ts instead.',
        },
      ],
    },
  },

  // ── Domain files: ban direct npm/Node imports that bypass canonical providers ──
  // Layering rule (enforced here): domain code never imports infrastructure npm
  // clients directly. Providers are the ONE place that imports these packages;
  // domains import from providers.
  {
    files: ['src/domains/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'crypto',
              message: 'Import from providers/crypto.ts instead of Node crypto directly.',
            },
            {
              name: 'stripe',
              message: 'Import from providers/stripe.ts instead of using Stripe directly.',
              allowTypeImports: true,
            },
            {
              name: 'node-fetch',
              message: 'Use global fetch() instead of node-fetch. It is available in Node 18+.',
            },
            {
              name: 'uuid',
              message: 'Use randomUUID() from providers/crypto.ts instead of the uuid package.',
            },
            {
              name: 'fs',
              message:
                'File system access should go through a provider or be restricted to config.ts.',
            },
            {
              name: 'openai',
              message: 'Import from a provider instead of using the OpenAI SDK directly.',
            },
            {
              name: 'jsonwebtoken',
              message: 'Import from a provider instead of using jsonwebtoken directly.',
            },
            {
              name: '@supabase/supabase-js',
              message: 'Import from a provider instead of using the Supabase client directly.',
            },
            {
              name: 'node-cache',
              message: 'Import from a provider instead of using node-cache directly.',
            },
            {
              name: 'lru-cache',
              message: 'Import from a provider instead of using lru-cache directly.',
            },
            {
              name: 'multer',
              message: 'Import from a provider or configure multer in your domain config.ts.',
            },
            {
              name: 'vcards-js',
              message: 'Import from a provider instead of using vcards-js directly.',
            },
          ],
        },
      ],
    },
  },

  // ── Domain config.ts files: fs allowed here — this IS the sanctioned home ──
  // The fs restriction above says "restricted to config.ts"; this override makes
  // that policy real instead of forcing per-line disables in every config.ts.
  {
    files: ['src/domains/**/config.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'crypto',
              message: 'Import from providers/crypto.ts instead of Node crypto directly.',
            },
            {
              name: 'stripe',
              message: 'Import from providers/stripe.ts instead of using Stripe directly.',
              allowTypeImports: true,
            },
            {
              name: 'node-fetch',
              message: 'Use global fetch() instead of node-fetch. It is available in Node 18+.',
            },
            {
              name: 'uuid',
              message: 'Use randomUUID() from providers/crypto.ts instead of the uuid package.',
            },
            {
              name: 'openai',
              message: 'Import from a provider instead of using the OpenAI SDK directly.',
            },
            {
              name: 'jsonwebtoken',
              message: 'Import from a provider instead of using jsonwebtoken directly.',
            },
            {
              name: '@supabase/supabase-js',
              message: 'Import from a provider instead of using the Supabase client directly.',
            },
            {
              name: 'node-cache',
              message: 'Import from a provider instead of using node-cache directly.',
            },
            {
              name: 'lru-cache',
              message: 'Import from a provider instead of using lru-cache directly.',
            },
            {
              name: 'vcards-js',
              message: 'Import from a provider instead of using vcards-js directly.',
            },
          ],
        },
      ],
    },
  },

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
