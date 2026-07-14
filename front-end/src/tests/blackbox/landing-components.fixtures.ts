import { vi } from 'vitest';

const MARKERS_FIXTURE = {
  fps: 30,
  customization: {
    introStart: 0,
    introEnd: 0.967,
    cycleStart: 0.967,
    cycleEnd: 14.3,
    outroStart: 14.333,
    outroEnd: 15.267,
    outroAnthropicStart: 67.4667,
    outroAnthropicEnd: 68.4,
    outroGeminiStart: 68.4333,
    outroGeminiEnd: 69.3667,
    outroMetaStart: 69.4,
    outroMetaEnd: 70.3333,
    outroDeepseakStart: 70.3667,
    outroDeepseakEnd: 71.3333,
  },
  conversations: {
    introStart: 15.267,
    introEnd: 16.233,
    cycleStart: 16.233,
    cycleEnd: 22.9,
    outroStart: 22.933,
    outroEnd: 23.9,
  },
  engine: {
    introStart: 23.9,
    introEnd: 24.9,
    cycleStart: 27.2,
    cycleEnd: 35.467,
    outroStart: 39.533,
    outroEnd: 40.533,
  },
  memory: {
    introStart: 40.567,
    introEnd: 41.5,
    cycleStart: 41.533,
    cycleEnd: 50.8,
    outroStart: 49.833,
    outroEnd: 49.833,
  },
  privacy: {
    introStart: 50.866,
    introEnd: 51.833,
    cycleStart: 51.833,
    cycleEnd: 60.133,
    outroStart: 66.466,
    outroEnd: 67.433,
  },
};

export function installStaticAssetFetch() {
  const originalFetch = global.fetch;
  const stubbedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (url.includes('navi-features-markers.json')) {
      return new Response(JSON.stringify(MARKERS_FIXTURE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('.webm') || url.endsWith('.mov')) {
      return new Response(new Blob([new Uint8Array([0, 1, 2, 3])], { type: 'video/webm' }), {
        status: 200,
        headers: { 'Content-Type': 'video/webm' },
      });
    }
    return originalFetch(input as RequestInfo, init);
  });
  global.fetch = stubbedFetch;
  return () => {
    global.fetch = originalFetch;
  };
}
