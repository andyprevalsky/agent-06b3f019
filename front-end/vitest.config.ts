import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(
      'test-anon-key-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.fake',
    ),
    'import.meta.env.VITE_BACKEND_API_URL': JSON.stringify('http://localhost:3001'),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/tests/blackbox/setup.ts'],
    include: [
      'src/tests/blackbox/**/*.blackbox.{ts,tsx}',
      'src/tests/structural/**/*.test.{ts,tsx}',
    ],
    globals: true,
    css: false,
    maxWorkers: 8,
    minWorkers: 1,
    // Coverage instrumentation plus the deploy workflow's concurrent backend
    // verifier can push the full Terminal interaction tests past Vitest's 5s
    // default on shared CI/developer machines. Keep a bounded but realistic
    // ceiling so genuine hangs still fail quickly.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/tests/**',
        'src/**/*.d.ts',
        'src/**/*.stories.{ts,tsx}',
        'src/main.tsx',
        'src/vite-env.d.ts',
        // Canvas / WebGL / shader animation code — runs an rAF draw loop that
        // never executes meaningfully in jsdom. jsdom returns a stub GL context
        // so component mounts succeed, but draw work is unreachable.
        'src/hooks/useXmlFrameReplay.ts',
        'src/hooks/useSmallTileAnimations.ts',
        'src/hooks/useTimeBasedAnimations.ts',
        'src/lib/proceduralTileAnimation.ts',
        'src/lib/openingAnimation.ts',
        'src/lib/smallTileAnimations.ts',
        'src/lib/shaderTileAnimations.ts',
        'src/lib/tileAnimation.ts',
        'src/dev/**',
        'src/components/ThinkingAnimation.tsx',
        'src/features/terminal-component-group/components/SmallTileAnimationCanvas.tsx',
        'src/features/terminal-component-group/components/BrowserBorderGlow.tsx',
        'src/features/terminal-component-group/components/browserBorderGlow/**',
        'src/features/terminal-component-group/components/BrowserCursorOverlay.tsx',
        // shadcn/ui primitives — vendored third-party components, covered by
        // their upstream library's own test suite.
        'src/components/ui/**',
      ],
      // Target: 80% across all four metrics. Current (2026-04-17): lines ~80%,
      // statements ~79%, functions ~77%, branches ~72%. Thresholds rounded down
      // to the nearest 5% — act as a ratchet, bump upward as tests land.
      thresholds: {
        lines: 80,
        statements: 75,
        functions: 75,
        branches: 70,
      },
    },
  },
});
