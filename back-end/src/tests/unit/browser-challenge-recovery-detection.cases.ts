import assert from 'node:assert';
import {
  challengeDetectionReason,
  isUsableDocumentTitle,
  pageLooksChallenged,
} from '../../providers/browser/challengeRecovery';

export function testChallengeDetection(): void {
  assert.ok(pageLooksChallenged({ status: 403, title: '', bodyText: '', html: '' }));
  assert.ok(
    pageLooksChallenged({
      status: 200,
      title: 'Just a moment',
      bodyText: 'Please verify you are human',
      html: '',
    })
  );
  // Sparse body + challenge-platform script still counts as a wall.
  assert.ok(
    pageLooksChallenged({
      status: 200,
      title: 'Store',
      bodyText: 'Coffee',
      html: '<script src="/cdn-cgi/challenge-platform/x.js"></script>',
    })
  );
  assert.ok(
    !pageLooksChallenged({
      status: 200,
      title: 'Blue Bottle Coffee',
      bodyText: 'Order drinks and pastries',
      html: '<main>Menu</main>',
    })
  );
  assert.ok(
    pageLooksChallenged({
      status: null,
      title: '',
      bodyText: '',
      html: '<html><head></head><body></body></html>',
    })
  );
  // Eventim cleared ticket HTML embeds Turnstile + challenge-platform beside
  // real inventory — must not false-positive once body text is substantive.
  assert.ok(
    !pageLooksChallenged({
      status: 200,
      title: 'Buy tickets to LYNY in San Francisco on August 14, 2026',
      bodyText:
        'General Admission Tier 1 $25.00 Add to cart Select quantity and continue to checkout.',
      html:
        '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>' +
        '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>' +
        '<main>General Admission</main>',
    })
  );
  assert.ok(
    pageLooksChallenged({
      status: 200,
      title: 'Access Denied',
      bodyText: 'You have been blocked. Access Denied. Ray ID a2685f1cff22d940.',
      html: '<script src="/cdn-cgi/challenge-platform/x.js"></script>',
    })
  );
  // RCA: agent-payment-production-purchase (882509fd) — Kernel returns HTTP 502
  // with x-kernel-proxy-error: provider_blacklisted for checkout.stripe.com.
  // Without classifying that page as challenged, Kernel residential/ISP
  // candidates "win" the config search and recovery falsely reports success.
  assert.ok(
    pageLooksChallenged({
      status: 502,
      title: 'Bad Gateway',
      bodyText: 'Proxy error',
      html: '<html><body>Bad Gateway</body></html>',
    }),
    'HTTP 502 must count as challenged so Kernel blacklist exits cannot win'
  );
  assert.ok(
    pageLooksChallenged({
      status: 200,
      title: 'Error',
      bodyText: 'Upstream refused: provider_blacklisted for this destination',
      html: '',
    }),
    'provider_blacklisted body text must count as challenged'
  );
  assert.ok(
    pageLooksChallenged({
      status: 200,
      title: 'Proxy Error',
      bodyText: 'Blocked',
      html: '<html><body>x-kernel-proxy-error: provider_blacklisted</body></html>',
    }),
    'x-kernel-proxy-error HTML must count as challenged'
  );
  // Substantive merchant body + "just a moment" buried in a script/i18n bundle
  // must NOT false-positive — that discarded Stripe-capable exits.
  assert.ok(
    !pageLooksChallenged({
      status: 200,
      title: 'Buy tickets to LYNY',
      bodyText:
        'General Admission Tier 1 $25.00 Add to cart Select quantity and continue to checkout now.',
      html:
        '<script>window.__i18n={"errors":{"rate":"too many requests","cf":"just a moment","deny":"access denied"}}</script>' +
        '<main>General Admission</main>',
    }),
    'generic challenge prose in script bundles must not flag a cleared page'
  );

  // Soft-wall navigation shells (any vendor): empty / bare-hostname /
  // Loading-URL titles must not win probes even with long body text.
  const shellBody =
    'Boutique hotel description that already appears in meta/noscript while the soft-wall has not produced a real document title yet.';
  assert.ok(!isUsableDocumentTitle(''));
  assert.ok(!isUsableDocumentTitle('www.example.com'));
  assert.ok(!isUsableDocumentTitle('example.com'));
  assert.ok(!isUsableDocumentTitle('Loading https://www.example.com/rooms'));
  assert.ok(isUsableDocumentTitle('Boutique Hotel Near Downtown'));
  assert.strictEqual(
    challengeDetectionReason({
      status: null,
      title: '',
      bodyText: shellBody,
      html: '<main>shell</main>',
    }),
    'unusable_title'
  );
  assert.strictEqual(
    challengeDetectionReason({
      status: null,
      title: 'www.example.com',
      bodyText: shellBody,
      html: '<main>shell</main>',
    }),
    'unusable_title'
  );
  assert.strictEqual(
    challengeDetectionReason({
      status: null,
      title: 'Loading https://www.example.com/path',
      bodyText: shellBody,
      html: '<main>shell</main>',
    }),
    'unusable_title'
  );
  assert.ok(
    !pageLooksChallenged({
      status: 200,
      title: 'Boutique Hotel Near Downtown',
      bodyText: shellBody,
      html: '<main>Real inventory copy for rooms and rates.</main>',
    })
  );
}
