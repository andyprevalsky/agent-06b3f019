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
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('test-anon-key-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.fake'),
    'import.meta.env.VITE_BACKEND_API_URL': JSON.stringify('http://localhost:3001'),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/tests/blackbox/setup.ts'],
    include: ['src/tests/blackbox/**/*.blackbox.{ts,tsx}'],
    globals: true,
    css: false,
    maxWorkers: 30,
    minWorkers: 1,
  },
});
