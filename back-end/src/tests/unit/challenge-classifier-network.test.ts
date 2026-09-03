#!/usr/bin/env tsx
/**
 * Pure network-pin helpers used by challenge recovery classifier prompts.
 */
import assert from 'node:assert/strict';
import {
  NETWORK_ENTRY_CAP,
  citedNetworkHosts,
  selectNetworkEntriesForClassifier,
  urlsCitedInRecoveryReason,
  type NetworkSummaryEntry,
} from '../../providers/browser/challengeClassifierNetwork';

function testUrlsCitedInRecoveryReason(): void {
  assert.deepEqual(urlsCitedInRecoveryReason(null), []);
  assert.deepEqual(urlsCitedInRecoveryReason('   '), []);
  assert.deepEqual(urlsCitedInRecoveryReason('no urls here'), []);
  assert.deepEqual(
    urlsCitedInRecoveryReason(
      'Blocked https://cdn.example.com/challenge.js, and https://CDN.example.com/challenge.js again.'
    ),
    ['https://cdn.example.com/challenge.js']
  );
  assert.deepEqual(
    urlsCitedInRecoveryReason('See http://a.test/path?x=1 and also not-a-url://skip'),
    ['http://a.test/path']
  );
}

function testCitedNetworkHosts(): void {
  assert.deepEqual(citedNetworkHosts(undefined), []);
  assert.deepEqual(
    citedNetworkHosts('Hosts https://one.example/a and https://two.example/b and https://one.example/c'),
    ['one.example', 'two.example']
  );
}

function testSelectNetworkEntriesForClassifier(): void {
  assert.deepEqual(selectNetworkEntriesForClassifier([]), []);

  const entries: NetworkSummaryEntry[] = [
    { url: 'https://noise.example/a.js', status: 200 },
    { url: 'https://cdn.example.com/challenge.js', status: 403 },
    { name: 'https://cdn.example.com/challenge.js', status: 403 }, // dup by key
    { url: 'https://other.example/b.js', status: 500 },
    { url: '', status: 200 },
  ];
  const selected = selectNetworkEntriesForClassifier(entries, {
    recoveryReason: 'Blocked https://cdn.example.com/challenge.js',
    cap: 2,
  });
  assert.equal(selected.length, 2);
  assert.equal(selected[0]?.url, 'https://cdn.example.com/challenge.js');
  assert.equal(selected[1]?.url, 'https://noise.example/a.js');

  const capped = selectNetworkEntriesForClassifier(
    Array.from({ length: 5 }, (_, i) => ({ url: `https://x.test/${i}` })),
    { cap: 3 }
  );
  assert.equal(capped.length, 3);
  assert.equal(NETWORK_ENTRY_CAP, 600);
}

function main(): void {
  testUrlsCitedInRecoveryReason();
  testCitedNetworkHosts();
  testSelectNetworkEntriesForClassifier();
  process.stdout.write('PASS challenge classifier network helpers\n');
}

main();
