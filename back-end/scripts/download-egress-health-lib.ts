import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

export interface DownloadEgressHealthConfig {
  targetUrl: string;
  supabaseLogsUrl: string;
  supabaseAccessToken: string;
  renderLogsUrl: string;
  renderApiKey: string;
  renderOwnerId: string;
  renderServiceId: string;
  outputPath: string;
  probeCount: number;
  rangeBytes: number;
  minimumBytesPerSecond: number;
  maximumTtfbMs: number;
  windowMinutes: number;
  now?: Date;
  realUserIncidentCount?: number;
}

export interface ArtifactProbe {
  index: number;
  httpStatus: number;
  bytesReceived: number;
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
  ttfbMs: number;
  totalMs: number;
  bytesPerSecond: number;
  cacheStatus?: string;
  cacheAgeSeconds?: number;
  cfRay?: string;
  contentRange?: string;
}

interface EdgeLogRow {
  path?: unknown;
  status?: unknown;
  cache_status?: unknown;
  requests?: unknown;
  avg_origin_ms?: unknown;
  p95_origin_ms?: unknown;
}

interface ParsedTelemetryLog {
  component?: unknown;
  message?: unknown;
  event?: unknown;
  insert_id?: unknown;
  bytes_per_second?: unknown;
}

export interface DownloadEgressReport {
  status: 'healthy' | 'unhealthy';
  generatedAt: string;
  window: { start: string; end: string; minutes: number };
  targetUrl: string;
  probes: ArtifactProbe[];
  edge: {
    requests: number;
    serverErrors: number;
    errorRate: number;
    cacheStatuses: Record<string, number>;
    averageOriginMs: number;
    p95OriginMs: number;
    rows: EdgeLogRow[];
  };
  realUserTelemetry: {
    started: number;
    progress: number;
    completed: number;
    failed: number;
    slowCompleted: number;
    medianBytesPerSecond: number | null;
    duplicateEventsDropped: number;
    events: ParsedTelemetryLog[];
  };
  failures: string[];
  observabilityFailures: string[];
  summary: string;
}

/** Keep download incidents distinct from loss of the monitor's diagnostic sources. */
export function downloadEgressExitCode(report: DownloadEgressReport): 0 | 1 | 2 {
  if (report.failures.length > 0) return 1;
  if (report.observabilityFailures.length > 0) return 2;
  return 0;
}

function rounded(milliseconds: number): number {
  return Math.round(milliseconds * 100) / 100;
}

function numberValue(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function probeArtifact(
  targetUrl: string,
  index: number,
  rangeBytes: number
): Promise<ArtifactProbe> {
  return new Promise((resolveProbe, rejectProbe) => {
    const url = new URL(targetUrl);
    const start = performance.now();
    let dnsAt: number | undefined;
    let tcpAt: number | undefined;
    let tlsAt: number | undefined;
    let settled = false;
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      rejectProbe(error);
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'GET',
        headers: {
          Range: `bytes=0-${rangeBytes - 1}`,
          'User-Agent': 'rose-download-egress-monitor/1.0',
        },
        signal: AbortSignal.timeout(20_000),
      },
      (response) => {
        const responseAt = performance.now();
        let bytesReceived = 0;
        const finishProbe = (): void => {
          if (settled) return;
          settled = true;
          const end = performance.now();
          const transferSeconds = Math.max((end - responseAt) / 1000, 0.001);
          const age = Number(response.headers.age);
          resolveProbe({
            index,
            httpStatus: response.statusCode ?? 0,
            bytesReceived,
            dnsMs: dnsAt === undefined ? undefined : rounded(dnsAt - start),
            tcpMs: tcpAt === undefined ? undefined : rounded(tcpAt - start),
            tlsMs: tlsAt === undefined ? undefined : rounded(tlsAt - start),
            ttfbMs: rounded(responseAt - start),
            totalMs: rounded(end - start),
            bytesPerSecond: Math.round(bytesReceived / transferSeconds),
            cacheStatus: response.headers['cf-cache-status'] as string | undefined,
            cacheAgeSeconds: Number.isFinite(age) ? age : undefined,
            cfRay: response.headers['cf-ray'] as string | undefined,
            contentRange: response.headers['content-range'],
          });
        };
        response.on('data', (chunk: Buffer) => {
          const remaining = Math.max(rangeBytes - bytesReceived, 0);
          bytesReceived += Math.min(chunk.length, remaining);
          if (bytesReceived >= rangeBytes) {
            finishProbe();
            response.destroy();
          }
        });
        response.once('end', finishProbe);
        response.once('error', rejectOnce);
        response.once('aborted', () => {
          rejectOnce(new Error(`Artifact response aborted after ${bytesReceived} bytes`));
        });
        response.once('close', () => {
          if (!settled && response.complete) finishProbe();
          else if (!settled) {
            rejectOnce(new Error(`Artifact response closed after ${bytesReceived} bytes`));
          }
        });
      }
    );
    request.on('socket', (socket) => {
      socket.once('lookup', () => {
        dnsAt = performance.now();
      });
      socket.once('connect', () => {
        tcpAt = performance.now();
      });
      socket.once('secureConnect', () => {
        tlsAt = performance.now();
      });
    });
    request.once('error', rejectOnce);
    request.end();
  });
}

async function fetchJson(url: URL, authorization: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(
      `${url.origin}${url.pathname} returned ${response.status}: ${(await response.text()).slice(0, 300)}`
    );
  }
  return (await response.json()) as unknown;
}

function edgeSql(): string {
  return `
SELECT
  log_attributes['request.path'] AS path,
  toInt32OrZero(log_attributes['response.status_code']) AS status,
  log_attributes['response.headers.cf_cache_status'] AS cache_status,
  count() AS requests,
  round(avg(toFloat64OrZero(log_attributes['response.origin_time'])), 2) AS avg_origin_ms,
  round(quantile(0.95)(toFloat64OrZero(log_attributes['response.origin_time'])), 2) AS p95_origin_ms
FROM logs
WHERE source = 'edge_logs'
  AND log_attributes['request.path'] LIKE '%/storage/v1/object/public/Releases/mac/%'
GROUP BY path, status, cache_status
ORDER BY requests DESC`.trim();
}

async function fetchEdgeRows(
  config: DownloadEgressHealthConfig,
  start: Date,
  end: Date
): Promise<EdgeLogRow[]> {
  const url = new URL(config.supabaseLogsUrl);
  url.searchParams.set('sql', edgeSql());
  url.searchParams.set('iso_timestamp_start', start.toISOString());
  url.searchParams.set('iso_timestamp_end', end.toISOString());
  const body = (await fetchJson(url, `Bearer ${config.supabaseAccessToken}`)) as {
    result?: unknown;
    error?: unknown;
  };
  if (body.error !== null && body.error !== undefined && body.error !== '') {
    throw new Error(`Supabase logs query failed: ${String(body.error)}`);
  }
  if (!Array.isArray(body.result)) {
    throw new Error('Supabase logs query returned no result array');
  }
  return body.result as EdgeLogRow[];
}

async function fetchTelemetryLogs(
  config: DownloadEgressHealthConfig,
  start: Date,
  end: Date
): Promise<ParsedTelemetryLog[]> {
  const events: ParsedTelemetryLog[] = [];
  let pageStart = start.toISOString();
  let pageEnd = end.toISOString();
  const seenPages = new Set<string>();
  const maximumPages = 30;

  for (let page = 1; page <= maximumPages; page += 1) {
    const url = new URL(config.renderLogsUrl);
    url.searchParams.set('ownerId', config.renderOwnerId);
    url.searchParams.set('resource', config.renderServiceId);
    url.searchParams.set('startTime', pageStart);
    url.searchParams.set('endTime', pageEnd);
    url.searchParams.set('direction', 'backward');
    url.searchParams.set('limit', '100');
    url.searchParams.set('type', 'app');
    url.searchParams.set('text', 'DownloadTelemetry');
    const body = (await fetchJson(url, `Bearer ${config.renderApiKey}`)) as {
      hasMore?: unknown;
      nextStartTime?: unknown;
      nextEndTime?: unknown;
      logs?: unknown;
    };
    if (!Array.isArray(body.logs)) {
      throw new Error('Render logs query returned no logs array');
    }
    for (const log of body.logs as Array<{ message?: unknown }>) {
      if (typeof log.message !== 'string') continue;
      try {
        const parsed = JSON.parse(log.message) as ParsedTelemetryLog;
        if (
          parsed.component === 'DownloadTelemetry' &&
          parsed.message === 'Mac updater download telemetry'
        ) {
          events.push(parsed);
        }
      } catch {
        // Render may include unrelated non-JSON platform lines despite the text filter.
      }
    }
    if (body.hasMore !== true) return events;
    if (typeof body.nextStartTime !== 'string' || typeof body.nextEndTime !== 'string') {
      throw new Error('Render logs query indicated more results without pagination timestamps');
    }
    const pageKey = `${body.nextStartTime}:${body.nextEndTime}`;
    if (seenPages.has(pageKey)) {
      throw new Error('Render logs pagination repeated a page cursor');
    }
    seenPages.add(pageKey);
    pageStart = body.nextStartTime;
    pageEnd = body.nextEndTime;
  }
  throw new Error(`Render logs pagination exceeded ${maximumPages} pages`);
}

function aggregateEdge(rows: EdgeLogRow[]): DownloadEgressReport['edge'] {
  let requests = 0;
  let serverErrors = 0;
  let weightedOriginMs = 0;
  let p95OriginMs = 0;
  const cacheStatuses: Record<string, number> = {};
  for (const row of rows) {
    const count = numberValue(row.requests);
    const status = numberValue(row.status);
    requests += count;
    if (status >= 500) serverErrors += count;
    weightedOriginMs += numberValue(row.avg_origin_ms) * count;
    p95OriginMs = Math.max(p95OriginMs, numberValue(row.p95_origin_ms));
    const cacheStatus =
      typeof row.cache_status === 'string' && row.cache_status !== ''
        ? row.cache_status
        : 'UNKNOWN';
    cacheStatuses[cacheStatus] = (cacheStatuses[cacheStatus] ?? 0) + count;
  }
  return {
    requests,
    serverErrors,
    errorRate: requests === 0 ? 0 : serverErrors / requests,
    cacheStatuses,
    averageOriginMs: requests === 0 ? 0 : Math.round(weightedOriginMs / requests),
    p95OriginMs,
    rows,
  };
}

function aggregateTelemetry(
  events: ParsedTelemetryLog[],
  minimumBytesPerSecond: number
): DownloadEgressReport['realUserTelemetry'] {
  const counts = {
    started: 0,
    progress: 0,
    completed: 0,
    failed: 0,
  };
  const completedSpeeds: number[] = [];
  const observedInsertIds = new Set<string>();
  let duplicateEventsDropped = 0;
  for (const event of events) {
    if (typeof event.insert_id === 'string' && event.insert_id !== '') {
      if (observedInsertIds.has(event.insert_id)) {
        duplicateEventsDropped += 1;
        continue;
      }
      observedInsertIds.add(event.insert_id);
    }
    if (event.event === 'mac_update_download_started') counts.started += 1;
    if (event.event === 'mac_update_download_progress') counts.progress += 1;
    if (event.event === 'mac_update_download_completed') {
      counts.completed += 1;
      const speed = numberValue(event.bytes_per_second);
      if (speed > 0) completedSpeeds.push(speed);
    }
    if (event.event === 'mac_update_download_failed') counts.failed += 1;
  }
  return {
    ...counts,
    slowCompleted: completedSpeeds.filter((speed) => speed < minimumBytesPerSecond).length,
    medianBytesPerSecond: median(completedSpeeds),
    duplicateEventsDropped,
    events,
  };
}

function writeReport(outputPath: string, report: DownloadEgressReport): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, outputPath);
}

export async function runDownloadEgressHealth(
  config: DownloadEgressHealthConfig
): Promise<DownloadEgressReport> {
  const end = config.now ?? new Date();
  const start = new Date(end.getTime() - config.windowMinutes * 60_000);
  const failures: string[] = [];
  const observabilityFailures: string[] = [];
  const probes: ArtifactProbe[] = [];

  for (let index = 1; index <= config.probeCount; index += 1) {
    try {
      probes.push(await probeArtifact(config.targetUrl, index, config.rangeBytes));
    } catch (error) {
      failures.push(
        `Artifact probe ${index} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  let edgeRows: EdgeLogRow[] = [];
  let telemetryEvents: ParsedTelemetryLog[] = [];
  const [edgeResult, telemetryResult] = await Promise.allSettled([
    fetchEdgeRows(config, start, end),
    fetchTelemetryLogs(config, start, end),
  ]);
  if (edgeResult.status === 'fulfilled') edgeRows = edgeResult.value;
  else observabilityFailures.push(`Supabase edge logs unavailable: ${String(edgeResult.reason)}`);
  if (telemetryResult.status === 'fulfilled') telemetryEvents = telemetryResult.value;
  else {
    observabilityFailures.push(
      `Render download telemetry unavailable: ${String(telemetryResult.reason)}`
    );
  }

  const successfulProbes = probes.filter(
    (probe) => probe.httpStatus === 206 && probe.bytesReceived === config.rangeBytes
  );
  if (successfulProbes.length !== config.probeCount) {
    failures.push(
      `Expected ${config.probeCount} successful HTTP 206 range probes; received ${successfulProbes.length}/${config.probeCount}`
    );
  }
  const slowTtfb = successfulProbes.filter((probe) => probe.ttfbMs > config.maximumTtfbMs);
  if (slowTtfb.length > 0) {
    failures.push(
      `${slowTtfb.length} probe(s) exceeded ${config.maximumTtfbMs}ms time-to-first-byte`
    );
  }
  const probeMedianSpeed = median(successfulProbes.map((probe) => probe.bytesPerSecond));
  if (probeMedianSpeed !== null && probeMedianSpeed < config.minimumBytesPerSecond) {
    failures.push(
      `Median range throughput ${probeMedianSpeed} B/s is below ${config.minimumBytesPerSecond} B/s`
    );
  }

  const edge = aggregateEdge(edgeRows);
  if (edge.serverErrors > 0) {
    failures.push(`Supabase edge logs contain ${edge.serverErrors} server error request(s)`);
  }
  const realUserTelemetry = aggregateTelemetry(telemetryEvents, config.minimumBytesPerSecond);
  const incidentCount = config.realUserIncidentCount ?? 2;
  if (realUserTelemetry.failed >= incidentCount) {
    failures.push(`${realUserTelemetry.failed} real updater downloads failed`);
  }
  if (realUserTelemetry.slowCompleted >= incidentCount) {
    failures.push(`${realUserTelemetry.slowCompleted} real updater downloads completed slowly`);
  }

  const status = failures.length === 0 ? 'healthy' : 'unhealthy';
  const report: DownloadEgressReport = {
    status,
    generatedAt: end.toISOString(),
    window: { start: start.toISOString(), end: end.toISOString(), minutes: config.windowMinutes },
    targetUrl: config.targetUrl,
    probes,
    edge,
    realUserTelemetry,
    failures,
    observabilityFailures,
    summary:
      `${status.toUpperCase()}: ${successfulProbes.length}/${config.probeCount} range probes; ` +
      `median ${probeMedianSpeed ?? 0} B/s; edge ${edge.serverErrors}/${edge.requests} 5xx; ` +
      `real downloads ${realUserTelemetry.completed} completed, ${realUserTelemetry.failed} failed; ` +
      `observability failures ${observabilityFailures.length}`,
  };
  writeReport(config.outputPath, report);
  return report;
}
