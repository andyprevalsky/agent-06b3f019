import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { app } from 'electron';

// app.isPackaged = true when running from built .app, false when running npm run dev
const envFile = app.isPackaged ? '.env.production' : '.env';
const envPath = app.isPackaged
  ? path.join(app.getAppPath(), envFile)
  : path.join(path.resolve(__dirname, '../../../../'), envFile);

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.log(`[Config] Loaded env from: ${envFile}`);
} else {
  console.warn(`[Config] Env file not found: ${envPath}`);
}

export function resolveApiUrl(rawUrl: string | undefined, isPackaged: boolean): string {
  const url = rawUrl?.trim();
  if (url !== undefined && url !== '') return url;
  if (isPackaged) {
    throw new Error('Missing VITE_BACKEND_API_URL for packaged Mac app');
  }
  return 'http://localhost:3001';
}

export const config = {
  apiUrl: resolveApiUrl(process.env.VITE_BACKEND_API_URL, app.isPackaged),
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
