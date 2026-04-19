import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { app } from 'electron';

// Load .env file from project root
// When compiled, __dirname will be dist/main/main/base/, so go up 4 levels to project root
const projectRoot = path.resolve(__dirname, '../../../../');

// app.isPackaged = true when running from built .app, false when running npm run dev
const envFile = app.isPackaged ? '.env.production' : '.env';
const envPath = path.join(projectRoot, envFile);

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.log(`[Config] Loaded env from: ${envFile}`);
} else {
  console.warn(`[Config] Env file not found: ${envPath}`);
}

export const config = {
  apiUrl: process.env.VITE_BACKEND_API_URL || 'http://localhost:3001',
  supabase: {
    url: process.env.VITE_SUPABASE_URL!,
    anonKey: process.env.VITE_SUPABASE_ANON_KEY!,
  },
  encryptionKey: process.env.ENCRYPTION_KEY || 'dev-only-change-in-production',
  isDev: !app.isPackaged,
};

if (!config.supabase.url || !config.supabase.anonKey) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY');
}
