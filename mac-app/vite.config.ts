import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist/ui',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        launcher: path.resolve(__dirname, 'launcher.html'),
      },
    },
  },
  resolve: {
    alias: {
      // Point @ to front-end src so shared components' internal imports resolve
      '@': path.resolve(__dirname, '../front-end/src'),
      '@shared': path.resolve(__dirname, '../front-end/src'),
    },
  },
});

