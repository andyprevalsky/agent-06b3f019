import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Domains under strict lint enforcement (type-aware rules, tighter limits).
 * The /setup-formatter-and-linter skill adds file paths here as domains are cleaned.
 * Paths are relative globs from mac-app/.
 */
const STRICT_DOMAIN_FILES = [
  'main/services/cookieSync.ts',
  'main/domains/cookie-sync/**/*.ts',
  'main/services/iMessageSync.ts',
  'main/domains/i-message-sync/**/*.ts',
  'ui/onboarding/**/*.{ts,tsx}',
  'ui/features/onboarding/**/*.{ts,tsx}',
  'main/handlers/registry.ts',
  'main/services/sync/**/*.ts',
  'main/domains/sync-manager/**/*.ts',
  'ui/ElectronApp.tsx',
  'main/services/messaging/MessageTransformer.ts',
  'main/services/messaging/index.ts',
  'main/services/messaging/types.ts',
  'main/domains/messaging-core/types.ts',
  'main/domains/messaging-core/config.ts',
  'main/domains/messaging-core/repo.ts',
  'main/domains/messaging-core/service.ts',
  'main/domains/messaging-core/runtime.ts',
  'main/services/browserStateSync.ts',
  'main/domains/browser-state-sync/**/*.ts',
  'ui/main.tsx',
  'main/services/batchUploader.ts',
  'main/domains/batch-uploader/**/*.ts',
  'main/services/IMessageQueueService.ts',
  'main/domains/i-message-queue-service/**/*.ts',
  'main/services/auth.ts',
  'main/domains/auth/**/*.ts',
  'main/services/claudeCredentialSync.ts',
  'main/domains/claude-credential-sync/**/*.ts',
  'main/services/messaging/platforms/telegram/**/*.ts',
  'main/domains/messaging-telegram/**/*.ts',
  'main/services/chromeProfileResolver.ts',
  'main/services/cookieReader.ts',
  'main/services/messaging/platforms/whatsapp/**/*.ts',
  'main/domains/messaging-whatsapp/**/*.ts',
  'main/services/messaging/platforms/imessage/**/*.ts',
  'main/services/uploader.ts',
  'main/domains/uploader/**/*.ts',
  'main/services/atlasCredentialStore.ts',
  'main/services/autoUpdater.ts',
  'main/domains/auto-updater/**/*.ts',
  'main/services/browserCookieReader.ts',
  'main/services/cacheStorageReader.ts',
  'main/services/fingerprintReader.ts',
  'main/services/localStorageReader.ts',
  'main/services/permissionReader.ts',
  'main/preload.ts',
  'main/services/browserPasswordReader.ts',
  'main/services/contactsReaderNative.ts',
  'main/services/indexedDBReader.ts',
  'main/services/iMessageSender.ts',
  'ui/launcher/**/*.{ts,tsx}',
  'ui/components/AgentPayModal.tsx',
  'ui/components/ApplePasswordsModal.tsx',
  'ui/components/AtlasPasswordModal.tsx',
  'ui/components/TelegramAuthModal.tsx',
  'ui/components/WhatsAppQRModal.tsx',
  'ui/features/electron-app/**/*.{ts,tsx}',
  'main/services/iMessageReader.ts',
  'main/domains/i-message-reader/**/*.ts',
];

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'scripts', 'assets', 'public'] },

  // ── Base config: all TypeScript files ──
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'prefer-const': 'error',
      'no-duplicate-imports': 'error',
      eqeqeq: ['error', 'always'],
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

  // ── Prettier compat (must be last — disables conflicting format rules) ──
  eslintConfigPrettier
);
