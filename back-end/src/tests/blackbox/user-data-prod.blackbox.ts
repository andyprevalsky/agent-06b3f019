#!/usr/bin/env tsx
/**
 * Read-only prod-path smoke for user document connectors.
 *
 * Runs only when credentials are provided through env or
 * .context/benchmarks/user-data-prod.json. The upload check uses dryRun=true,
 * so this validates deployed routing/parsing/auth without persisting prod data.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';
import { z } from 'zod';
config();

const RepoRoot = path.resolve(__dirname, '../../../..');
const ConfigPath = path.join(RepoRoot, '.context/benchmarks/user-data-prod.json');

const ProdConfigSchema = z.object({
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  grepPattern: z.string().min(1).optional(),
});

const DocumentsUploadResponse = z.object({
  integration: z.object({ id: z.string(), name: z.string(), status: z.string() }),
  documents: z.array(z.object({ id: z.string(), externalId: z.string() })),
  documentCount: z.number(),
  snapshotRevision: z.unknown().nullable(),
  syncState: z.object({
    id: z.string(),
    source: z.string(),
    status: z.string(),
    nextSyncAt: z.string().nullable(),
  }),
  dryRun: z.boolean(),
});

const SummaryResponse = z.object({ sources: z.record(z.unknown()) });
const GrepResponse = z.object({
  matches: z.array(z.unknown()),
  total_matches: z.number(),
  truncated: z.boolean(),
  sources: z.array(z.string()),
});
const SnapshotResponse = z.object({ snapshot: z.unknown().nullable().optional() });

function fileConfig(): z.infer<typeof ProdConfigSchema> {
  if (!fs.existsSync(ConfigPath)) return {};
  return ProdConfigSchema.parse(JSON.parse(fs.readFileSync(ConfigPath, 'utf8')));
}

function prodConfig() {
  const file = fileConfig();
  const cfg = {
    baseUrl:
      process.env.USER_DATA_PROD_BASE_URL ??
      process.env.PROD_BASE_URL ??
      file.baseUrl ??
      'https://navi-j9a9.onrender.com',
    apiKey: process.env.USER_DATA_PROD_API_KEY ?? process.env.BACKEND_API_KEY ?? file.apiKey,
    userId: process.env.USER_DATA_PROD_USER_ID ?? file.userId,
    grepPattern:
      process.env.USER_DATA_PROD_GREP_PATTERN ??
      file.grepPattern ??
      `rose-prod-smoke-${Date.now()}-no-match`,
  };
  if (!cfg.apiKey || !cfg.userId) return null;
  return cfg;
}

async function requestJson(url: string, options: RequestInit = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  let data: unknown = text;
  if (contentType.includes('application/json')) {
    data = JSON.parse(text);
  }
  if (!response.ok) {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    throw new Error(
      `HTTP ${response.status} ${url} (${contentType || 'unknown content-type'}): ${body.slice(0, 500)}`
    );
  }
  if (!contentType.includes('application/json')) {
    throw new Error(
      `HTTP ${response.status} ${url} returned ${contentType || 'unknown content-type'}, expected JSON`
    );
  }
  return data;
}

function headers(apiKey: string, userId: string): Record<string, string> {
  return { 'X-API-Key': apiKey, 'X-User-Id': userId };
}

async function runAll(): Promise<void> {
  const cfg = prodConfig();
  if (cfg === null) {
    process.stdout.write(
      `SKIP user-data prod smoke: set USER_DATA_PROD_API_KEY and USER_DATA_PROD_USER_ID, or ${ConfigPath}\n`
    );
    return;
  }

  const h = headers(cfg.apiKey, cfg.userId);
  const upload = await requestJson(`${cfg.baseUrl}/api/integrations/documents/upload`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      source: 'generic',
      dryRun: true,
      documents: [
        {
          externalId: 'prod-smoke-dry-run',
          title: 'Prod smoke dry run',
          content: 'Prod smoke validates document upload path without persistence.',
          metadata: { smoke: true },
        },
      ],
    }),
  });
  const uploadBody = DocumentsUploadResponse.parse(upload);
  if (!uploadBody.dryRun || uploadBody.documentCount !== 1) {
    throw new Error(`Unexpected dry-run upload body: ${JSON.stringify(uploadBody)}`);
  }
  process.stdout.write('PASS prod dry-run upload path\n');

  SummaryResponse.parse(await requestJson(`${cfg.baseUrl}/api/data/summary`, { headers: h }));
  process.stdout.write('PASS prod summary path\n');

  GrepResponse.parse(
    await requestJson(`${cfg.baseUrl}/api/data/grep`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        pattern: cfg.grepPattern,
        source: 'documents',
        head_limit: 1,
      }),
    })
  );
  process.stdout.write('PASS prod documents grep path\n');

  SnapshotResponse.parse(await requestJson(`${cfg.baseUrl}/api/data/snapshot`, { headers: h }));
  process.stdout.write('PASS prod snapshot path\n');
}

runAll().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
