/** Deliberately lossy projection: never copy arbitrary keys or strings. */
type Data = Record<string, unknown>;
const record = (value: unknown): Data =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numbers = (v: unknown) => (Array.isArray(v) ? v.filter(finite) : []);
const numeric = (v: Data, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => finite(v[k])).map((k) => [k, v[k]]));
const CPU = new Set(['CpuProfile', 'CPUProfile', 'Profile', 'ProfileChunk']);
const TIMING = new Set([
  'FunctionCall',
  'Layout',
  'UpdateLayoutTree',
  'Paint',
  'RunTask',
  'ThreadControllerImpl::RunTask',
  'ThreadPool_RunTask',
  'Task',
  'CommitLoad',
  'Animation',
]);
const PHASES = new Set(['B', 'E', 'X', 'I', 'i', 'P', 'C', 'b', 'e', 'n']);
const CATEGORIES = new Set([
  'blink.animations',
  'benchmark',
  'rail',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-v8.cpu_profiler',
  'toplevel',
]);
const INTERNAL = new Set(['(root)', '(program)', '(idle)', '(garbage collector)']);
const CSS_PROPERTIES = new Set([
  'border-top-color',
  'border-bottom-color',
  'border-left-color',
  'border-right-color',
  'color',
  'background-color',
  'box-shadow',
  'fill',
  'stroke',
  'opacity',
  'padding-left',
  'padding-right',
  'width',
  'height',
  'transform',
]);
const ANIMATION_STATES = new Set(['idle', 'pending', 'running', 'paused', 'finished']);
const hexId = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:0x)?[a-fA-F0-9]{1,32}$/.test(value);

export function assetPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    [...value].some((character) => character.charCodeAt(0) <= 32)
  )
    return '';
  if (value === '' || value === 'native') return value;
  try {
    if (!value.startsWith('/assets/') && !value.startsWith('https://')) return '';
    const url = new URL(value, 'https://www.roselabs.ai');
    if (
      url.protocol !== 'https:' ||
      url.port ||
      !['www.roselabs.ai', 'roselabs.ai'].includes(url.hostname)
    )
      return '';
    return /^\/assets\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.js$/.test(url.pathname)
      ? url.pathname
      : '';
  } catch {
    return '';
  }
}

function cpuProfile(value: unknown) {
  const p = record(value);
  const nodes = Array.isArray(p.nodes)
    ? p.nodes.flatMap((item) => {
        const n = record(item);
        if (!Number.isSafeInteger(n.id) || (n.id as number) < 0) return [];
        const f = record(n.callFrame);
        return [
          {
            id: n.id,
            callFrame: {
              url: assetPath(f.url),
              ...numeric(f, ['lineNumber', 'columnNumber']),
              functionName:
                typeof f.functionName === 'string' && INTERNAL.has(f.functionName)
                  ? f.functionName
                  : '',
              ...(typeof f.scriptId === 'string' && /^[0-9]{1,32}$/.test(f.scriptId)
                ? { scriptId: f.scriptId }
                : {}),
            },
            ...numeric(n, ['hitCount']),
            ...(Number.isSafeInteger(n.parent) && (n.parent as number) >= 0
              ? { parent: n.parent }
              : {}),
            children: numbers(n.children).filter(Number.isSafeInteger),
          },
        ];
      })
    : [];
  return {
    ...numeric(p, ['startTime', 'endTime']),
    nodes,
    samples: numbers(p.samples).filter(Number.isSafeInteger),
    timeDeltas: numbers(p.timeDeltas),
  };
}

export function sanitizeTrace(value: unknown) {
  const input = record(value).traceEvents;
  if (!Array.isArray(input)) throw new Error('trace-shape');
  let cpuChunks = 0,
    cpuNodes = 0,
    cpuSamples = 0,
    timingEvents = 0,
    mainFrameCommits = 0;
  let firstTimestampUs: number | null = null,
    lastTimestampUs: number | null = null;
  let markerStartPresent = false,
    markerEndPresent = false;
  const traceEvents = input.flatMap((item) => {
    const e = record(item);
    // Native Chrome clock-sync shape only; unknown shapes fail closed as missing markers.
    if (e.name === 'clock_sync') {
      const syncId = record(e.args).sync_id;
      if (
        e.cat !== '__metadata' ||
        e.ph !== 'c' ||
        !finite(e.ts) ||
        (syncId !== 'folder-profile-start' && syncId !== 'folder-profile-end')
      )
        return [];
      markerStartPresent ||= syncId === 'folder-profile-start';
      markerEndPresent ||= syncId === 'folder-profile-end';
      firstTimestampUs = Math.min(firstTimestampUs ?? e.ts, e.ts);
      lastTimestampUs = Math.max(lastTimestampUs ?? e.ts, e.ts);
      return [
        {
          name: 'clock_sync',
          cat: '__metadata',
          ph: 'c',
          ...numeric(e, ['pid', 'tid', 'ts']),
          args: { sync_id: syncId },
        },
      ];
    }
    if (
      typeof e.name !== 'string' ||
      (!CPU.has(e.name) && !TIMING.has(e.name)) ||
      typeof e.ph !== 'string' ||
      !PHASES.has(e.ph) ||
      !finite(e.ts) ||
      typeof e.cat !== 'string' ||
      !e.cat.split(',').every((category) => CATEGORIES.has(category))
    )
      return [];
    const d = record(record(e.args).data);
    let args: Data = {};
    if (CPU.has(e.name)) {
      const p = cpuProfile(d.cpuProfile);
      cpuChunks++;
      cpuNodes += p.nodes.length;
      cpuSamples += p.samples.length;
      args = {
        data: {
          ...numeric(d, ['startTime', 'endTime']),
          cpuProfile: p,
          timeDeltas: numbers(d.timeDeltas),
          lines: numbers(d.lines),
        },
      };
    } else {
      timingEvents++;
      if (e.name === 'FunctionCall')
        args = {
          data: {
            url: assetPath(d.url ?? d.scriptName),
            ...numeric(d, ['lineNumber', 'columnNumber']),
          },
        };
      if (e.name === 'CommitLoad' && typeof d.isMainFrame === 'boolean') {
        args = { data: { isMainFrame: d.isMainFrame } };
        if (d.isMainFrame) mainFrameCommits++;
      }
      if (e.name === 'Animation') {
        args = {
          data: {
            ...numeric(d, ['nodeId', 'id']),
            ...(typeof d.displayName === 'string' && CSS_PROPERTIES.has(d.displayName)
              ? { displayName: d.displayName }
              : {}),
            ...(typeof d.state === 'string' && ANIMATION_STATES.has(d.state)
              ? { state: d.state }
              : {}),
          },
        };
      }
    }
    firstTimestampUs = Math.min(firstTimestampUs ?? e.ts, e.ts);
    const end = e.ts + (finite(e.dur) && e.dur >= 0 ? e.dur : 0);
    lastTimestampUs = Math.max(lastTimestampUs ?? end, end);
    const id = hexId(e.id) ? e.id : finite(e.id) ? e.id : undefined;
    return [
      {
        name: e.name,
        cat: CPU.has(e.name) ? 'disabled-by-default-v8.cpu_profiler' : 'devtools.timeline',
        ph: e.ph,
        ...numeric(e, ['pid', 'tid', 'ts', 'dur', 'tts', 'tdur']),
        ...(id === undefined ? {} : { id }),
        ...(e.name === 'Animation' && hexId(record(e.id2).local)
          ? { id2: { local: record(e.id2).local } }
          : {}),
        args,
      },
    ];
  });
  return {
    traceEvents,
    coverage: {
      inputEvents: input.length,
      keptEvents: traceEvents.length,
      cpuChunks,
      cpuNodes,
      cpuSamples,
      timingEvents,
      firstTimestampUs,
      lastTimestampUs,
      mainFrameCommits,
      markerStartPresent,
      markerEndPresent,
      navigationCoverage: mainFrameCommits >= 2 ? 'multiple-main-frame-commits' : 'unconfirmed',
    },
  };
}
