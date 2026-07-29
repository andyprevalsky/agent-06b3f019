#!/usr/bin/env tsx

import { resolve } from 'node:path';
import { config as loadEnvironment } from 'dotenv';
import { runDownloadEgressHealth } from './download-egress-health-lib';

loadEnvironment({ path: resolve(__dirname, '../.env') });
loadEnvironment({ path: resolve(__dirname, '../../agents/.env') });

const projectRef = process.env.SUPABASE_PROJECT_REF ?? 'kzlurqihzaolhzsbkctf';

async function main(): Promise<void> {
  const report = await runDownloadEgressHealth({
    targetUrl:
      process.env.DOWNLOAD_EGRESS_TARGET_URL ??
      `https://${projectRef}.supabase.co/storage/v1/object/public/Releases/mac/latest/Rose-mac.dmg`,
    supabaseLogsUrl:
      process.env.SUPABASE_LOGS_URL ??
      `https://api.supabase.com/v1/projects/${projectRef}/analytics/endpoints/logs`,
    supabaseAccessToken: process.env.SUPABASE_ACCESS_TOKEN ?? '',
    renderLogsUrl: process.env.RENDER_LOGS_URL ?? 'https://api.render.com/v1/logs',
    renderApiKey: process.env.RENDER_API_KEY ?? '',
    renderOwnerId: process.env.RENDER_OWNER_ID ?? 'tea-csppgi56l47c73djvpig',
    renderServiceId: process.env.RENDER_SERVICE_ID ?? '',
    outputPath: resolve(
      process.env.DOWNLOAD_EGRESS_REPORT_PATH ?? '../.context/download-egress/report.json'
    ),
    probeCount: 3,
    rangeBytes: 4 * 1024 * 1024,
    minimumBytesPerSecond: 1_000_000,
    maximumTtfbMs: 2500,
    windowMinutes: 60,
    realUserIncidentCount: 2,
  });

  process.stdout.write(`${report.summary}\n`);
  if (report.failures.length > 0) {
    for (const failure of report.failures) process.stderr.write(`- ${failure}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
