import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: '::',
    port: parseInt(process.env.VITE_DEV_PORT || '8080'),
    allowedHosts: ['.ngrok-free.dev', '.ngrok.app', '.ngrok.io'],
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
