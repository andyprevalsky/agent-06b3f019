import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "::",
    port: parseInt(process.env.VITE_DEV_PORT || "8080"),
    allowedHosts: process.env.VITE_ALLOWED_HOSTS?.split(",").filter(Boolean),
    proxy: {
      "/anthropic-proxy": {
        target: `http://localhost:${process.env.BACKEND_PORT || "3000"}`,
        changeOrigin: true,
      },
      "/codex-proxy": {
        target: `http://localhost:${process.env.BACKEND_PORT || "3000"}`,
        changeOrigin: true,
      },
    },
    hmr: process.env.VITE_ALLOWED_HOSTS
      ? {
          clientPort: 443,
        }
      : undefined,
    proxy: {
      '/api': {
        target: process.env.VITE_BACKEND_API_URL || 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
}));
