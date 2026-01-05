import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5174,
  },
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
    // Resolve dependencies from front-end's node_modules
    dedupe: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'],
  },
  // Also look in front-end/node_modules for dependencies
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'],
  },
});

