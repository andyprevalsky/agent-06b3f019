import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/blackbox/local-storage-reader.blackbox.ts'], environment: 'node', root: '/home/boxes/rose/mac-app' } });
