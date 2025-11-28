import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load .env file from project root
// When compiled, __dirname will be dist/main/main/base/, so go up 4 levels to project root
const projectRoot = path.resolve(__dirname, '../../../../');

const envCandidates = [
  path.join(projectRoot, '.env.production'),
  path.join(projectRoot, '.env'),
];

const envPath = envCandidates.find((candidate) => fs.existsSync(candidate));

if (envPath) {
  dotenv.config({ path: envPath });
}

export const config = {
  apiUrl: process.env.VITE_BACKEND_URL || 'http://localhost:3001',
  supabase: {
    url: process.env.VITE_SUPABASE_URL!,
    anonKey: process.env.VITE_SUPABASE_ANON_KEY!,
  },
  encryptionKey: process.env.ENCRYPTION_KEY || 'dev-only-change-in-production',
  isDev: process.env.NODE_ENV === 'development',
};

if (!config.supabase.url || !config.supabase.anonKey) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY');
}

