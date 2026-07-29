#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { runDownloadEgressHealth } from '../../../scripts/download-egress-health-lib';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'rose-download-egress-'));
let artifactStatus = 206;
let observedRange = '';
let observedSupabaseAuth = '';
let observedRenderAuth = '';
let observedLogsSql = '';

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/artifact') {
    observedRange = request.headers.range ?? '';
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': artifactStatus === 206 ? '1024' : '0',
      'Cache-Control': 'public, max-age=60',
      'CF-Cache-Status': artifactStatus === 206 ? 'HIT' : 'MISS',
      'CF-Ray': 'blackbox-SJC',
    };
    if (artifactStatus === 206) headers['Content-Range'] = 'bytes 0-1023/152852260';
    response.writeHead(artifactStatus, headers);
    response.end(artifactStatus === 206 ? Buffer.alloc(1024, 7) : undefined);
    return;
  }
  if (url.pathname === '/supabase-logs') {
    observedSupabaseAuth = request.headers.authorization ?? '';
    observedLogsSql = url.searchParams.get('sql') ?? '';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        error: null,
        result: [
          {
            path: '/storage/v1/object/public/Releases/mac/latest/Rose-mac.dmg',
            status: 206,
            cache_status: 'HIT',
            requests: 8,
            avg_origin_ms: 210,
            p95_origin_ms: 420,
          },
        ],
      })
    );
    return;
  }
  if (url.pathname === '/render-logs') {
    observedRenderAuth = request.headers.authorization ?? '';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        hasMore: false,
        logs: [
          {
            timestamp: '2026-07-29T22:30:01.000Z',
            message: JSON.stringify({
              component: 'DownloadTelemetry',
              message: 'Mac updater download telemetry',
              event: 'mac_update_download_completed',
              insert_id: 'download-complete-123',
              version: '2.4.6',
              session_id: 'download-session-123',
              elapsed_ms: 92_000,
              bytes_per_second: 1_660_000,
              transferred_bytes: 152_852_260,
              total_bytes: 152_852_260,
            }),
          },
          {
            timestamp: '2026-07-29T22:30:02.000Z',
            message: JSON.stringify({
              component: 'DownloadTelemetry',
              message: 'Mac updater download telemetry',
              event: 'mac_update_download_completed',
              insert_id: 'download-complete-123',
              version: '2.4.6',
              session_id: 'download-session-123',
              elapsed_ms: 92_000,
              bytes_per_second: 1_660_000,
              transferred_bytes: 152_852_260,
              total_bytes: 152_852_260,
            }),
          },
        ],
      })
    );
    return;
  }
  response.writeHead(404).end();
});

async function main(): Promise<void> {
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = (server.address() as AddressInfo).port;
  const outputPath = join(temporaryDirectory, 'report.json');
  const commonConfig = {
    targetUrl: `http://127.0.0.1:${port}/artifact`,
    supabaseLogsUrl: `http://127.0.0.1:${port}/supabase-logs`,
    supabaseAccessToken: 'supabase-test-token',
    renderLogsUrl: `http://127.0.0.1:${port}/render-logs`,
    renderApiKey: 'render-test-token',
    renderOwnerId: 'tea-test',
    renderServiceId: 'srv-test',
    outputPath,
    probeCount: 3,
    rangeBytes: 1024,
    minimumBytesPerSecond: 1,
    maximumTtfbMs: 2_000,
    windowMinutes: 60,
    now: new Date('2026-07-29T23:00:00.000Z'),
  };

  const healthy = await runDownloadEgressHealth(commonConfig);
  assert.equal(healthy.status, 'healthy');
  assert.equal(healthy.probes.length, 3);
  assert.equal(
    healthy.probes.every((probe) => probe.httpStatus === 206),
    true
  );
  assert.equal(healthy.edge.requests, 8);
  assert.equal(healthy.edge.serverErrors, 0);
  assert.equal(healthy.realUserTelemetry.completed, 1);
  assert.equal(healthy.realUserTelemetry.failed, 0);
  assert.equal(healthy.realUserTelemetry.duplicateEventsDropped, 1);
  assert.equal(healthy.realUserTelemetry.medianBytesPerSecond, 1_660_000);
  assert.equal(observedRange, 'bytes=0-1023');
  assert.equal(observedSupabaseAuth, 'Bearer supabase-test-token');
  assert.equal(observedRenderAuth, 'Bearer render-test-token');
  assert.match(observedLogsSql, /FROM logs/i);
  assert.match(observedLogsSql, /source = 'edge_logs'/i);
  assert.match(observedLogsSql, /Releases\/mac/);
  assert.equal(existsSync(outputPath), true);
  assert.equal(JSON.parse(readFileSync(outputPath, 'utf8')).status, 'healthy');

  artifactStatus = 503;
  const unhealthy = await runDownloadEgressHealth({
    ...commonConfig,
    outputPath: join(temporaryDirectory, 'failed-report.json'),
  });
  assert.equal(unhealthy.status, 'unhealthy');
  assert.match(unhealthy.failures.join('\n'), /three successful range probes|HTTP 206/i);

  const workflowPath = resolve(process.cwd(), '..', '.github', 'workflows', 'download-egress.yml');
  const workflow = readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /cron:\s*['"]?[^'"\n]*\/15/);
  assert.match(workflow, /SUPABASE_ACCESS_TOKEN/);
  assert.match(workflow, /RENDER_API_KEY/);
  assert.match(workflow, /upload-artifact/);
  assert.match(workflow, /SLACK_BOT_TOKEN/);
  assert.match(workflow, /previous.*conclusion|PREVIOUS_CONCLUSION/is);
  assert.match(workflow, /download-egress-health\.ts/);

  process.stdout.write('download egress synthetic monitor tests passed\n');
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    server.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });
