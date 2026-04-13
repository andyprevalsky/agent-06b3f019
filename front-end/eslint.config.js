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
  'src/contexts/AgentContext.tsx',
  'src/main.tsx',
  'src/pages/Integrations.tsx',
  'src/pages/Terminal.tsx',
  'src/pages/Usage.tsx',
  // Terminal domain: composed orchestration hook with many sub-hooks
  'src/features/terminal/hooks/useTerminalAgents.ts',
  // Index domain: large video/animation components with complex browser-interop code
  'src/features/index/components/FeatureVideoStage.tsx',
  'src/features/index/components/HeroSection.tsx',
  'src/features/index/components/FeaturesSection.tsx',
  'src/features/index/components/PreOrderSection.tsx',
  'src/features/index/components/WaitlistSection.tsx',
  'src/features/index/components/WaitlistForm.tsx',
  'src/features/index/components/VideoPlayer.tsx',
  'src/features/index/components/VideoLoadingAnimation.tsx',
  'src/features/index/components/ProgressiveImage.tsx',
  'src/features/index/components/PoweredByTicker.tsx',
  // Terminal-component-group: all UI components are legacy (moved from src/components/terminal/)
  'src/features/terminal-component-group/components/AgentListItem.tsx',
  'src/features/terminal-component-group/components/AgentSettingsDialog.tsx',
  'src/features/terminal-component-group/components/AppSidebar.tsx',
  'src/features/terminal-component-group/components/ApprovalChip.tsx',
  'src/features/terminal-component-group/components/AsciiLoader.tsx',
  'src/features/terminal-component-group/components/AttentionInbox.tsx',
  'src/features/terminal-component-group/components/BrowserBorderGlow.tsx',
  'src/features/terminal-component-group/components/BrowserCursorOverlay.tsx',
  'src/features/terminal-component-group/components/BrowserStatusBar.tsx',
  'src/features/terminal-component-group/components/BrowserStatusBarCarousel.tsx',
  'src/features/terminal-component-group/components/BrowserViewPanel.tsx',
  'src/features/terminal-component-group/components/ClaudeCodeChip.tsx',
  'src/features/terminal-component-group/components/CompletionSummaryCard.tsx',
  'src/features/terminal-component-group/components/CostLimitModal.tsx',
  'src/features/terminal-component-group/components/CreateAgentModal.tsx',
  'src/features/terminal-component-group/components/ExploreAgentBubble.tsx',
  'src/features/terminal-component-group/components/FeedbackBanner.tsx',
  'src/features/terminal-component-group/components/MarkdownText.tsx',
  'src/features/terminal-component-group/components/MessageBubble.tsx',
  'src/features/terminal-component-group/components/MessageList.tsx',
  'src/features/terminal-component-group/components/NetworkView.tsx',
  'src/features/terminal-component-group/components/PhoneCallCard.tsx',
  'src/features/terminal-component-group/components/PlanArtifact.tsx',
  'src/features/terminal-component-group/components/PlanChip.tsx',
  'src/features/terminal-component-group/components/QueryInput.tsx',
  'src/features/terminal-component-group/components/RoseToolSetChip.tsx',
  'src/features/terminal-component-group/components/SignupPromptBubble.tsx',
  'src/features/terminal-component-group/components/SmallTileAnimationCanvas.tsx',
  'src/features/terminal-component-group/components/SubAgentToolBubble.tsx',
  'src/features/terminal-component-group/components/SubAgentTree.tsx',
  'src/features/terminal-component-group/components/TestPromptsSelector.tsx',
  'src/features/terminal-component-group/components/WaitForChip.tsx',
  'src/features/terminal-component-group/components/WriteLockToggle.tsx',
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
            'no-empty': 'off',
          },
        },
      ]
    : []),

  // ── Storybook ──────────────────────────────────────────────────────────
  ...storybook.configs['flat/recommended'],

  // ── Prettier compat (must be last — disables conflicting format rules) ──
  eslintConfigPrettier,
);
