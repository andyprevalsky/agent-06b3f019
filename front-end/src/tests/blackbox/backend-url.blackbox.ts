import { describe, expect, it } from 'vitest';

import { backendApiUrl, resolveBackendBaseUrl } from '@/lib/backendUrl';

describe('backend URL resolution', () => {
  it('uses an explicit backend URL when Vite provides one', () => {
    expect(resolveBackendBaseUrl('http://localhost:55120/')).toBe('http://localhost:55120');
  });

  it('keeps the default local URL on the default local frontend port', () => {
    expect(
      resolveBackendBaseUrl(
        'http://localhost:3001',
        {
          protocol: 'http:',
          hostname: 'localhost',
          port: '3002',
        },
        true,
      ),
    ).toBe('http://localhost:3001');
  });

  it('treats the default local URL as stale on dynamic Conductor ports', () => {
    expect(
      resolveBackendBaseUrl(
        'http://localhost:3001',
        {
          protocol: 'http:',
          hostname: 'localhost',
          port: '55121',
        },
        true,
      ),
    ).toBe('http://localhost:55120');
  });

  it('keeps the explicit backend URL in Electron where the renderer port is independent', () => {
    expect(
      resolveBackendBaseUrl(
        'http://localhost:3001',
        {
          protocol: 'http:',
          hostname: 'localhost',
          port: '5174',
        },
        true,
        true,
      ),
    ).toBe('http://localhost:3001');
  });

  it('recognizes Electron only through the dedicated preload sentinel', () => {
    window.api = { isElectron: true };
    expect(
      resolveBackendBaseUrl(
        'http://localhost:3001',
        {
          protocol: 'http:',
          hostname: 'localhost',
          port: '55121',
        },
        true,
      ),
    ).toBe('http://localhost:3001');
    window.api = {};
    expect(
      resolveBackendBaseUrl(
        'http://localhost:3001',
        {
          protocol: 'http:',
          hostname: 'localhost',
          port: '55121',
        },
        true,
      ),
    ).toBe('http://localhost:55120');
  });

  it('uses the same-origin Vite proxy when a public dev host has a local backend URL', () => {
    expect(
      resolveBackendBaseUrl(
        'http://localhost:55020',
        {
          protocol: 'https:',
          hostname: 'rose-washington.ngrok.app',
          port: '',
        },
        true,
      ),
    ).toBe('');
  });

  it('infers the paired backend port for local Vite dev servers', () => {
    expect(
      resolveBackendBaseUrl(
        undefined,
        {
          protocol: 'http:',
          hostname: 'localhost',
          port: '55121',
        },
        true,
      ),
    ).toBe('http://localhost:55120');
  });

  it('keeps explicit URLs in Vitest even when jsdom uses localhost:3000', () => {
    expect(
      resolveBackendBaseUrl('http://localhost:3001', {
        protocol: 'http:',
        hostname: 'localhost',
        port: '3000',
      }),
    ).toBe('http://localhost:3001');
  });

  it('adds /api when callers need the API prefix', () => {
    expect(backendApiUrl()).toBe('http://localhost:3001/api');
  });
});
