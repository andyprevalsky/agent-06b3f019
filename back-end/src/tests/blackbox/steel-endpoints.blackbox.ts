#!/usr/bin/env tsx

import { steelApiUrl, steelCdpUrl } from '../../providers/steel/session';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function main(): void {
  const previous = process.env.STEEL_API_KEY;
  process.env.STEEL_API_KEY = 'steel-test-key';
  try {
    assert(
      steelApiUrl('/v1/sessions/session-1') ===
        'https://connect.steelbrowser.com/v1/sessions/session-1',
      'Steel HTTP helper used a stale origin'
    );
    const cdpUrl = new URL(steelCdpUrl('session-1'));
    assert(cdpUrl.protocol === 'wss:', 'Steel CDP helper did not use WebSocket TLS');
    assert(cdpUrl.hostname === 'connect.steelbrowser.com', 'Steel CDP helper used a stale origin');
    assert(cdpUrl.searchParams.get('apiKey') === 'steel-test-key', 'Steel CDP key missing');
    assert(cdpUrl.searchParams.get('sessionId') === 'session-1', 'Steel session ID missing');
    console.log('PASS Steel HTTP and CDP helpers use the live steelbrowser.com origin');
  } finally {
    if (previous === undefined) delete process.env.STEEL_API_KEY;
    else process.env.STEEL_API_KEY = previous;
  }
}

main();
