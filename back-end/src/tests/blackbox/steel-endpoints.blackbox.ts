#!/usr/bin/env tsx

import {
  steelApiUrl,
  steelCdpConnectionUrl,
  steelCdpUrl,
  steelDebugUrl,
  steelPublicCdpUrl,
} from '../../providers/steel/session';

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
    assert(cdpUrl.searchParams.get('apiKey') === null, 'persisted Steel CDP URL leaked its key');
    assert(cdpUrl.searchParams.get('sessionId') === 'session-1', 'Steel session ID missing');
    const connectionUrl = new URL(steelCdpConnectionUrl(cdpUrl.toString()));
    assert(
      connectionUrl.searchParams.get('apiKey') === 'steel-test-key',
      'Steel CDP connection key missing'
    );
    const legacyPublicUrl = new URL(
      steelPublicCdpUrl('wss://connect.steel.dev?sessionId=legacy-session&APIKEY=legacy-secret')
    );
    assert(
      legacyPublicUrl.searchParams.get('apiKey') === null,
      'legacy Steel key was not redacted'
    );
    assert(
      legacyPublicUrl.searchParams.get('sessionId') === 'legacy-session',
      'legacy Steel session ID was lost while redacting'
    );
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
    console.log('PASS Steel URLs keep API keys local to the CDP connection boundary');
  } finally {
    if (previous === undefined) delete process.env.STEEL_API_KEY;
    else process.env.STEEL_API_KEY = previous;
  }
}

main();
