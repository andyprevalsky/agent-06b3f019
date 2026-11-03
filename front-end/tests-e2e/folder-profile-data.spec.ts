import { test, expect } from '@playwright/test';
import { assetPath, sanitizeTrace } from './folder-profile-data';

test('only trusted public asset paths survive URL projection', () => {
  expect(
    assetPath('https://user:secret@www.roselabs.ai/assets/index-Ab.js?access_token=secret#secret'),
  ).toBe('/assets/index-Ab.js');
  expect(assetPath('/assets/chunk.js?apiKey=secret')).toBe('/assets/chunk.js');
  for (const value of [
    'wss://host/assets/a.js?auth=secret',
    'blob:https://www.roselabs.ai/id',
    'data:text/plain,secret',
    '//evil/assets/a.js',
    'https://evil/assets/a.js',
    'text https://www.roselabs.ai/assets/a.js',
    'https://[',
    '/assets/../secret.js',
    '/assets/a%2fb.js',
    ' https://www.roselabs.ai/assets/a.js',
    null,
  ])
    expect(assetPath(value)).toBe('');
});

test('allowlist keeps profile topology and timings, never arbitrary nested payloads', () => {
  const secret = 'SENTINEL_AUTH';
  const output = sanitizeTrace({
    traceEvents: [
      {
        name: 'ProfileChunk',
        cat: 'disabled-by-default-v8.cpu_profiler',
        ph: 'P',
        ts: 10,
        pid: 1,
        tid: 2,
        id: '0x1',
        args: {
          password: secret,
          data: {
            access_token: secret,
            timeDeltas: [2, 3],
            cpuProfile: {
              nodes: [
                {
                  id: 1,
                  children: [2],
                  callFrame: {
                    functionName: secret,
                    url: 'wss://x/?token=' + secret,
                    lineNumber: 4,
                    auth: { headers: { authorization: secret } },
                  },
                  deoptReason: secret,
                },
              ],
              samples: [1],
              refresh_token: secret,
            },
          },
        },
      },
      {
        name: 'FunctionCall',
        cat: 'devtools.timeline',
        ph: 'X',
        ts: 12,
        dur: 5,
        args: {
          data: {
            scriptName: '/assets/main.js?password=' + secret,
            functionName: secret,
            lineNumber: 9,
            nodeName: secret,
            apiKey: secret,
            payload: { auth: secret },
          },
        },
      },
      {
        name: 'CommitLoad',
        cat: 'devtools.timeline',
        ph: 'I',
        ts: 13,
        args: { data: { isMainFrame: true, url: secret } },
      },
      {
        name: 'CommitLoad',
        cat: 'devtools.timeline',
        ph: 'I',
        ts: 18,
        args: { data: { isMainFrame: true } },
      },
      { name: secret, ph: 'I', ts: 19, cat: 'blink.user_timing', args: { secret } },
      { name: 'FunctionCall', ph: 'I', ts: 20, cat: 'blink.user_timing', args: { secret } },
    ],
    metadata: { password: secret },
  });
  expect(JSON.stringify(output)).not.toContain(secret);
  expect(output.traceEvents).toHaveLength(4);
  expect(output.coverage).toMatchObject({
    cpuChunks: 1,
    cpuNodes: 1,
    timingEvents: 3,
    firstTimestampUs: 10,
    lastTimestampUs: 18,
    navigationCoverage: 'multiple-main-frame-commits',
  });
  expect(JSON.stringify(output)).toContain('/assets/main.js');
});

test('malformed or missing evidence never invents timestamps or navigation coverage', () => {
  expect(() => sanitizeTrace({ traceEvents: 'bad' })).toThrow('trace-shape');
  const output = sanitizeTrace({
    traceEvents: [
      null,
      { name: 'Paint', cat: 'devtools.timeline', ph: 'X', ts: NaN },
      {
        name: 'CommitLoad',
        cat: 'devtools.timeline',
        ph: 'I',
        ts: 1,
        args: { data: { isMainFrame: 'true' } },
      },
    ],
  });
  expect(output.coverage).toMatchObject({
    cpuNodes: 0,
    mainFrameCommits: 0,
    navigationCoverage: 'unconfirmed',
    firstTimestampUs: 1,
    lastTimestampUs: 1,
  });
});

test('profile variants and timeline events preserve only their declared fields', () => {
  const names = ['CpuProfile', 'CPUProfile', 'Profile', 'ProfileChunk'];
  const events = names.map((name) => ({
    name,
    cat: 'disabled-by-default-v8.cpu_profiler',
    ph: 'P',
    ts: 1,
    args: {
      data: {
        cpuProfile: {
          startTime: 1,
          endTime: 4,
          nodes: [
            {
              id: 1,
              hitCount: 2,
              callFrame: {
                functionName: '(root)',
                url: '/assets/app.js?secret=sentinel',
                lineNumber: 0,
                columnNumber: 2,
              },
            },
          ],
          samples: [1],
          timeDeltas: [3],
        },
      },
    },
  }));
  const timeline = ['Layout', 'UpdateLayoutTree', 'Paint', 'RunTask'].map((name) => ({
    name,
    cat: 'devtools.timeline',
    ph: 'X',
    ts: 4,
    dur: 5,
    args: { data: { nodeName: 'sentinel', headers: { password: 'sentinel' } } },
  }));
  const result = sanitizeTrace({ traceEvents: [...events, ...timeline] });
  expect(result.coverage).toMatchObject({
    cpuChunks: 4,
    cpuNodes: 4,
    cpuSamples: 4,
    timingEvents: 4,
    lastTimestampUs: 9,
  });
  expect(JSON.stringify(result)).not.toContain('sentinel');
  expect(JSON.stringify(result)).toContain('(root)');
});

test('native parent-linked profile chunks retain stack topology and DevTools frame fields', () => {
  const result = sanitizeTrace({
    traceEvents: [
      {
        name: 'ProfileChunk',
        cat: 'disabled-by-default-v8.cpu_profiler',
        ph: 'P',
        ts: 100,
        args: {
          data: {
            cpuProfile: {
              nodes: [
                {
                  id: 1,
                  callFrame: {
                    functionName: '(root)',
                    scriptId: '0',
                    url: '',
                    lineNumber: -1,
                    columnNumber: -1,
                  },
                },
                {
                  id: 2,
                  parent: 1,
                  callFrame: {
                    functionName: 'PRIVATE_GOAL',
                    scriptId: '123',
                    url: '/assets/main.js',
                    lineNumber: 7,
                    columnNumber: 4,
                  },
                },
                { id: 3, parent: 'PRIVATE_GOAL', callFrame: { scriptId: 'PRIVATE_GOAL' } },
              ],
              samples: [2],
            },
            timeDeltas: [10],
          },
        },
      },
    ],
  });
  const profile = (
    result.traceEvents[0].args.data as { cpuProfile: { nodes: unknown[]; samples: number[] } }
  ).cpuProfile;
  expect(profile.nodes[1]).toMatchObject({
    id: 2,
    parent: 1,
    callFrame: {
      functionName: '',
      scriptId: '123',
      url: '/assets/main.js',
      lineNumber: 7,
      columnNumber: 4,
    },
  });
  expect(profile.nodes[0]).toMatchObject({ callFrame: { functionName: '(root)', scriptId: '0' } });
  expect(profile.samples).toEqual([2]);
  expect(JSON.stringify(result)).not.toContain('PRIVATE_GOAL');
});

test('Animation retains allowlisted properties and linked phases without DOM goal strings', () => {
  const result = sanitizeTrace({
    traceEvents: ['b', 'n', 'e']
      .map((ph, i) => ({
        name: 'Animation',
        cat: 'blink.animations,devtools.timeline,benchmark,rail',
        ph,
        ts: 100 + i,
        id2: { local: '0xabc', global: 'PRIVATE_GOAL' },
        args: {
          data: {
            displayName: 'border-top-color',
            state: 'running',
            nodeId: 42,
            id: 7,
            nodeName: 'PRIVATE_GOAL',
            goal: 'PRIVATE_GOAL',
            payload: { auth: 'PRIVATE_GOAL' },
          },
        },
      }))
      .concat([
        {
          name: 'Animation',
          cat: 'devtools.timeline',
          ph: 'b',
          ts: 104,
          id2: { local: 'PRIVATE_GOAL', global: 'PRIVATE_GOAL' },
          args: {
            data: {
              displayName: 'PRIVATE_GOAL',
              state: 'PRIVATE_GOAL',
              nodeId: 'PRIVATE_GOAL',
              id: 'PRIVATE_GOAL',
              nodeName: 'PRIVATE_GOAL',
              goal: 'PRIVATE_GOAL',
              payload: { auth: 'PRIVATE_GOAL' },
            },
          },
        },
      ] as never[]),
  });
  expect(result.traceEvents.slice(0, 3).map((e) => e.ph)).toEqual(['b', 'n', 'e']);
  for (const event of result.traceEvents.slice(0, 3)) {
    expect(event).toMatchObject({
      id2: { local: '0xabc' },
      args: { data: { displayName: 'border-top-color', state: 'running', nodeId: 42, id: 7 } },
    });
  }
  expect(result.traceEvents[3].args).toEqual({ data: {} });
  expect(result.traceEvents[3]).not.toHaveProperty('id2');
  expect(JSON.stringify(result)).not.toContain('PRIVATE_GOAL');
});

test('only fixed native clock markers establish capture boundary evidence', () => {
  const marker = (sync_id: string, ts: number) => ({
    name: 'clock_sync',
    cat: '__metadata',
    ph: 'c',
    ts,
    args: { sync_id, payload: 'PRIVATE_GOAL', headers: { authorization: 'PRIVATE_GOAL' } },
  });
  const result = sanitizeTrace({
    traceEvents: [
      marker('folder-profile-start', 1),
      marker('folder-profile-end', 9),
      marker('PRIVATE_GOAL', 10),
      { ...marker('folder-profile-end', 11), cat: 'blink.user_timing' },
      { ...marker('folder-profile-end', 12), ph: 'I' },
      {
        name: 'clock_sync',
        cat: '__metadata',
        ph: 'c',
        ts: 13,
        args: { data: { sync_id: 'folder-profile-end' } },
      },
    ],
  });
  expect(result.traceEvents).toHaveLength(2);
  expect(result.coverage).toMatchObject({ markerStartPresent: true, markerEndPresent: true });
  expect(result.traceEvents[1].args).toEqual({ sync_id: 'folder-profile-end' });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_GOAL');
  expect(
    sanitizeTrace({ traceEvents: [marker('folder-profile-start', 1)] }).coverage,
  ).toMatchObject({ markerStartPresent: true, markerEndPresent: false });
  expect(sanitizeTrace({ traceEvents: [] }).coverage).toMatchObject({
    markerStartPresent: false,
    markerEndPresent: false,
  });
});
