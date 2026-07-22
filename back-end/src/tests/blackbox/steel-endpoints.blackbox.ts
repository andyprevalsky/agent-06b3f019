#!/usr/bin/env tsx

import { steelApiUrl, steelCdpUrl, steelDebugUrl } from '../../providers/steel/session';

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
    const debugUrl = new URL(
      steelDebugUrl('https://api.steel.dev/v1/sessions/session-1/player?legacy=true')
    );
    assert(debugUrl.hostname === 'connect.steelbrowser.com', 'Steel live view used a stale origin');
    assert(
      debugUrl.searchParams.get('legacy') === 'true',
      'Steel live-view query parameters were lost'
    );
    assert(
      debugUrl.searchParams.get('interactive') === 'false',
      'Steel live view was not read-only'
    );
    console.log('PASS Steel HTTP, CDP, and live-view helpers use the live steelbrowser.com origin');
  } finally {
    if (previous === undefined) delete process.env.STEEL_API_KEY;
    else process.env.STEEL_API_KEY = previous;
  }
}

main();
