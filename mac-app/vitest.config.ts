import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirror vite.config.ts: `@` resolves to front-end/src because mac-app's
    // renderer reuses front-end components via the shared alias. Do not change
    // without updating vite.config.ts.
    alias: {
      '@': path.resolve(__dirname, '../front-end/src'),
      '@shared': path.resolve(__dirname, '../front-end/src'),
      // `@paper-design/shaders` is declared as a front-end/ dependency only,
      // but mac-app renderer entries (launcher, onboarding) import it
      // transitively for liquid-metal shader chrome. Alias the bare specifier
      // to a test-time stub so vitest can resolve the module graph in jsdom
      // without pulling WebGL into the test runtime. Tests never assert on
      // shader output.
      '@paper-design/shaders': path.resolve(
        __dirname,
        'tests/blackbox/stubs/paper-design-shaders.ts'
      ),
    },
  },
  define: {
    // Front-end modules (e.g. @/lib/supabase) throw at import time if these env
    // vars are missing. Provide deterministic test values — individual tests
    // never hit the real Supabase.
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(
      'test-anon-key-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.fake'
    ),
    'import.meta.env.VITE_BACKEND_API_URL': JSON.stringify('http://localhost:3001'),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['tests/blackbox/setup.ts'],
    include: ['tests/blackbox/**/*.blackbox.{ts,tsx}'],
    globals: true,
    css: false,
    pool: 'forks',
    // /deploy intentionally runs coverage and blackbox verification together.
    // Bound each Vitest process so the pair cannot over-subscribe every CPU
    // core and starve async module setup past the suite's real timeouts.
    minWorkers: 1,
    maxWorkers: 2,
    testTimeout: 10000,
    hookTimeout: 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['main/**/*.{ts,tsx}', 'shared/**/*.{ts,tsx}', 'ui/**/*.{ts,tsx}'],
      exclude: [
        'dist/**',
        'node_modules/**',
        'tests/**',
        '**/*.d.ts',
        '**/types.ts',
        'ui/assets/**',
        'ui/fonts.css',
        'ui/index.css',
      ],
      // Target: at least 80% across all metrics. Baseline on 2026-05-07 after
      // onboarding-data/error-utils coverage: lines/statements 80.05%,
      // branches 85.26%, functions 83.58%.
      // Ratchet thresholds upward as coverage improves; never lower them.
      thresholds: {
        lines: 80,
        statements: 80,
        branches: 85,
        functions: 80,
      },
    },
  },
});
