#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  downloadEgressExitCode,
  runDownloadEgressHealth,
} from '../../../scripts/download-egress-health-lib';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'rose-download-egress-'));
let artifactStatus = 206;
let artifactBytes = 1024;
let supabaseServerErrors = 0;
let invalidSupabaseResult = false;
let invalidRenderLogs = false;
let paginateRenderLogs = false;
let renderLogRequests = 0;
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
      'Content-Length': String(artifactBytes),
      'Cache-Control': 'public, max-age=60',
      'CF-Cache-Status': artifactStatus === 206 ? 'HIT' : 'MISS',
      'CF-Ray': 'blackbox-SJC',
    };
    if (artifactStatus === 206) headers['Content-Range'] = 'bytes 0-1023/152852260';
    response.writeHead(artifactStatus, headers);
    response.end(Buffer.alloc(artifactBytes, 7));
    return;
  }
  if (url.pathname === '/supabase-logs') {
    observedSupabaseAuth = request.headers.authorization ?? '';
    observedLogsSql = url.searchParams.get('sql') ?? '';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify(
        invalidSupabaseResult
          ? { error: null }
          : {
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
                ...(supabaseServerErrors === 0
                  ? []
                  : [
                      {
                        path: '/storage/v1/object/public/Releases/mac/latest/Rose-mac.dmg',
                        status: 503,
                        cache_status: 'MISS',
                        requests: supabaseServerErrors,
                        avg_origin_ms: 500,
                        p95_origin_ms: 500,
                      },
                    ]),
              ],
            }
      )
    );
    return;
  }
  if (url.pathname === '/render-logs') {
    renderLogRequests += 1;
    observedRenderAuth = request.headers.authorization ?? '';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (invalidRenderLogs) {
      response.end(JSON.stringify({ hasMore: false, logs: null }));
      return;
    }
    if (paginateRenderLogs) {
      const firstPage = url.searchParams.get('endTime') === '2026-07-29T23:00:00.000Z';
      response.end(
        JSON.stringify({
          hasMore: firstPage,
          nextStartTime: firstPage ? '2026-07-29T22:00:00.000Z' : undefined,
          nextEndTime: firstPage ? '2026-07-29T22:30:00.000Z' : undefined,
          logs: [
            {
              message: JSON.stringify({
                component: 'DownloadTelemetry',
                message: 'Mac updater download telemetry',
                event: firstPage ? 'mac_update_download_completed' : 'mac_update_download_failed',
                insert_id: firstPage ? 'paginated-complete' : 'paginated-failed',
                bytes_per_second: firstPage ? 2_000_000 : undefined,
              }),
            },
          ],
        })
      );
      return;
    }
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
  assert.equal(downloadEgressExitCode(healthy), 0);
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
  assert.doesNotMatch(observedLogsSql, /LIMIT\s+100/i);
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
  assert.equal(downloadEgressExitCode(unhealthy), 1);
  assert.match(unhealthy.failures.join('\n'), /3 successful range probes|HTTP 206/i);

  artifactStatus = 200;
  artifactBytes = 4096;
  const rangeIgnored = await runDownloadEgressHealth({
    ...commonConfig,
    outputPath: join(temporaryDirectory, 'range-ignored-report.json'),
  });
  assert.equal(
    rangeIgnored.probes.every((probe) => probe.bytesReceived === commonConfig.rangeBytes),
    true,
    'probe must stop reading when an origin ignores Range'
  );

  artifactStatus = 206;
  artifactBytes = 1024;
  supabaseServerErrors = 1;
  const edgeFailure = await runDownloadEgressHealth({
    ...commonConfig,
    outputPath: join(temporaryDirectory, 'edge-failure-report.json'),
  });
  assert.equal(edgeFailure.edge.serverErrors, 1);
  assert.match(edgeFailure.failures.join('\n'), /server error request/);

  supabaseServerErrors = 0;
  paginateRenderLogs = true;
  renderLogRequests = 0;
  const paginated = await runDownloadEgressHealth({
    ...commonConfig,
    outputPath: join(temporaryDirectory, 'paginated-report.json'),
  });
  assert.equal(renderLogRequests, 2);
  assert.equal(paginated.realUserTelemetry.completed, 1);
  assert.equal(paginated.realUserTelemetry.failed, 1);

  paginateRenderLogs = false;
  invalidSupabaseResult = true;
  const degradedObservability = await runDownloadEgressHealth({
    ...commonConfig,
    outputPath: join(temporaryDirectory, 'observability-report.json'),
  });
  assert.equal(degradedObservability.status, 'healthy');
  assert.equal(degradedObservability.failures.length, 0);
  assert.match(degradedObservability.observabilityFailures.join('\n'), /no result array/);
  assert.equal(downloadEgressExitCode(degradedObservability), 2);
  invalidSupabaseResult = false;

  invalidRenderLogs = true;
  const degradedRenderObservability = await runDownloadEgressHealth({
    ...commonConfig,
    outputPath: join(temporaryDirectory, 'render-observability-report.json'),
  });
  assert.equal(downloadEgressExitCode(degradedRenderObservability), 2);
  assert.match(degradedRenderObservability.observabilityFailures.join('\n'), /no logs array/);
  invalidRenderLogs = false;

  const workflowPath = resolve(process.cwd(), '..', '.github', 'workflows', 'download-egress.yml');
  const workflow = readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /cron:\s*['"]?[^'"\n]*\/15/);
  assert.match(workflow, /SUPABASE_ACCESS_TOKEN/);
  assert.match(workflow, /RENDER_API_KEY/);
  assert.match(workflow, /upload-artifact/);
  assert.match(workflow, /SLACK_BOT_TOKEN/);
  assert.match(workflow, /Mac download observability degraded/);
  assert.match(workflow, /if ! previous_conclusion=/);
  assert.match(workflow, /set -o pipefail/);
  assert.doesNotMatch(workflow, /-f event=/);
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
