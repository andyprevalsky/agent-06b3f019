#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import {
  restoredTunnelCandidate,
  type TunnelCandidateEvidence,
} from '../../providers/browser/challengeRecoveryTransport';

const targetUrl = 'https://checkout.example.test/test_payment';
const evidence: TunnelCandidateEvidence = {
  recoveryReason:
    'The previous browser failed POST /api/test-payment/confirm and navigation with net::ERR_TUNNEL_CONNECTION_FAILED.',
  classifierReason:
    'The old tunnel failure has no successful checkout POST in this candidate, despite a usable checkout page.',
  targetUrl,
  blockedResourceUrl: 'https://js.stripe.com/v3/',
  pageUrl: targetUrl,
  documentUrl: targetUrl,
  documentStatus: 200,
  documentMethod: 'GET',
  cleanedDom: 'Checkout ' + 'Aurora Notebook Ceramic Mug Canvas Tote Payment options '.repeat(3),
  networkEntries: [
    { url: targetUrl, status: 200 },
    { url: 'https://checkout.example.test/api/test-payment/products', status: 200 },
  ],
  failedRequestUrls: [],
};

assert.equal(restoredTunnelCandidate(evidence), true);
assert.equal(
  restoredTunnelCandidate({ ...evidence, recoveryReason: 'The checkout POST got HTTP 429.' }),
  false,
  'only a prior CONNECT failure can use this recovery path'
);
assert.equal(
  restoredTunnelCandidate({ ...evidence, documentUrl: 'https://other.example.test/test_payment' }),
  false,
  'the successful GET must traverse the same origin'
);
assert.equal(
  restoredTunnelCandidate({ ...evidence, documentStatus: 503 }),
  false,
  'a failed current document cannot promote'
);
assert.equal(
  restoredTunnelCandidate({
    ...evidence,
    failedRequestUrls: ['https://checkout.example.test/api/test-payment/products'],
  }),
  false,
  'a current same-origin network failure cannot promote'
);
assert.equal(
  restoredTunnelCandidate({ ...evidence, failedRequestUrls: ['https://js.stripe.com/v3/'] }),
  false,
  'a current failure of the blocked third-party resource cannot promote'
);
assert.equal(
  restoredTunnelCandidate({
    ...evidence,
    failedRequestUrls: ['https://metrics.example.test/ping'],
  }),
  true,
  'an unrelated third-party failure does not replay the historical tunnel error'
);
assert.equal(
  restoredTunnelCandidate({
    ...evidence,
    networkEntries: [
      { url: targetUrl, status: 200 },
      { url: 'https://checkout.example.test/api/test-payment/products', status: 429 },
    ],
  }),
  false,
  'a current same-origin HTTP block cannot promote'
);
assert.equal(
  restoredTunnelCandidate({
    ...evidence,
    networkEntries: [...evidence.networkEntries, { url: 'https://js.stripe.com/v3/', status: 503 }],
  }),
  false,
  'a current HTTP failure from the blocked third-party origin cannot promote'
);
assert.equal(
  restoredTunnelCandidate({ ...evidence, cleanedDom: 'Checking your browser' }),
  false,
  'a blank challenge page cannot promote'
);
assert.equal(
  restoredTunnelCandidate({
    ...evidence,
    classifierReason:
      'The current page displays a CAPTCHA interstitial despite the restored tunnel.',
  }),
  false,
  'a current visible challenge cannot promote'
);

process.stdout.write('PASS challenge recovery tunnel transport evidence\n');
