import type { Page, Response } from 'playwright';

const CHALLENGE_TEXT = [
  'access denied',
  'attention required! | cloudflare',
  'checking your browser',
  'enable javascript and cookies to continue',
  'just a moment',
  'performing security verification',
  'please verify you are a human',
  'sorry, you have been blocked',
  "this site can't be reached",
  'too many requests',
  'unusual traffic from your computer network',
  'verify you are human',
];
// Kernel proxy hard-blocks (e.g. checkout.stripe.com → provider_blacklisted).
// Safe to match in raw HTML: they never appear in legitimate merchant bundles.
const PROXY_ERROR_TEXT = ['provider_blacklisted', 'x-kernel-proxy-error', 'kernel-proxy-error'];
// Present on hard CF walls *and* on cleared pages that embed Bot Management /
// Turnstile (Eventim ticket HTML). Only count when visible body is still sparse.
const HTML_CHALLENGE_MARKERS = [
  '/cdn-cgi/challenge-platform',
  'cf-chl-',
  'challenges.cloudflare.com/turnstile',
];
const SUBSTANTIVE_BODY_CHARS = 80;
/** Provider-native CAPTCHA/challenge solvers need wall-clock room; soft-walls
 * often hydrate a real document title only after the first few polls. */
export const PROVIDER_SOLVER_WAIT_MS = 60_000;
// Chromium / anti-bot shells often expose these instead of a real document title
// while the wall is still up. Matching structure only — never a vendor or host.
const BARE_HOSTNAME_TITLE = /^(www\.)?([a-z0-9-]+\.)+[a-z]{2,}$/i;
const LOADING_URL_TITLE = /^loading\s+https?:\/\//i;
const URL_TITLE = /^https?:\/\//i;

/**
 * True when `title` looks like a real rendered document, not a navigation shell.
 *
 * Soft anti-bot walls (any vendor) commonly keep empty titles, bare hostnames
 * (`example.com`), or Chromium "Loading https://..." titles while body HTML is
 * already non-empty from meta/noscript. Treating those as clean made candidate
 * probes report stablePasses=2 in ~4s/attempt, then live verify correctly failed.
 */
export function isUsableDocumentTitle(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return false;
  if (LOADING_URL_TITLE.test(trimmed) || URL_TITLE.test(trimmed)) return false;
  if (BARE_HOSTNAME_TITLE.test(trimmed)) return false;
  return true;
}

export function challengeDetectionReason(input: {
  status: number | null;
  title: string;
  bodyText: string;
  html: string;
}): string | null {
  // 502: Kernel (and similar) proxy denials surface as Bad Gateway. Treating them
  // as challenged keeps a blacklisted Kernel exit from winning the config search.
  if (input.status === 403 || input.status === 429 || input.status === 502) {
    return `status_${input.status}`;
  }
  const content = `${input.title}\n${input.bodyText}`.toLowerCase();
  for (const marker of CHALLENGE_TEXT) {
    if (content.includes(marker)) return `text:${marker}`;
  }
  for (const marker of PROXY_ERROR_TEXT) {
    if (content.includes(marker)) return `text:${marker}`;
  }
  const html = input.html.toLowerCase();
  // Proxy-error markers are safe anywhere; generic CHALLENGE_TEXT is not —
  // script/i18n bundles on clean commerce pages embed "access denied" etc.
  for (const marker of PROXY_ERROR_TEXT) {
    if (html.includes(marker)) return `html_text:${marker}`;
  }
  const visibleMarkup = html.replace(/<[^>]+>/g, '').trim();
  if (!input.title.trim() && !input.bodyText.trim() && !visibleMarkup) return 'empty_page';
  // Cleared Eventim pages embed challenge-platform/Turnstile beside real
  // inventory copy — do not treat those script URLs as a wall once body text
  // is substantive. Same gate for generic html_text markers.
  if (input.bodyText.trim().length < SUBSTANTIVE_BODY_CHARS) {
    for (const marker of CHALLENGE_TEXT) {
      if (html.includes(marker)) return `html_text:${marker}`;
    }
    for (const marker of HTML_CHALLENGE_MARKERS) {
      if (html.includes(marker)) return `html:${marker}`;
    }
  }
  // Hard gate for probe stability: no usable document title ⇒ still challenged,
  // even when body text is already long (meta/noscript shells during soft walls).
  if (!isUsableDocumentTitle(input.title)) return 'unusable_title';
  return null;
}

export function pageLooksChallenged(input: {
  status: number | null;
  title: string;
  bodyText: string;
  html: string;
}): boolean {
  return challengeDetectionReason(input) !== null;
}

async function challengeSnapshot(page: Page, response: Response | null) {
  const [title, bodyText, html] = await Promise.all([
    page.title().catch(() => ''),
    page
      .locator('body')
      .innerText({ timeout: 2_000 })
      .catch(() => ''),
    page.content().catch(() => ''),
  ]);
  return {
    status: response?.status() ?? null,
    title: title.slice(0, 1_000),
    bodyText: bodyText.slice(0, 20_000),
    html: html.slice(0, 100_000),
  };
}

export async function waitForProviderSolver(
  page: Page,
  response: Response | null
): Promise<{ clean: boolean; reason: string | null; title: string }> {
  // Both candidate factories explicitly enable their provider-native solver.
  // Give it the first chance on every attempt, polling the page instead of
  // assuming a fixed solve duration. A clean page exits immediately — but only
  // after challengeDetectionReason accepts a usable document title (soft-walls
  // must not win on empty/hostname/"Loading https://..." shells).
  const deadline = Date.now() + PROVIDER_SOLVER_WAIT_MS;
  let currentResponse = response;
  let lastReason: string | null = 'probe_timeout';
  let lastTitle = '';
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    const snapshot = await challengeSnapshot(page, currentResponse);
    lastTitle = snapshot.title;
    lastReason = challengeDetectionReason(snapshot);
    if (lastReason === null) return { clean: true, reason: null, title: lastTitle };
    // Drop the navigation Response after the first poll so a stale 403/429/502
    // object cannot permanently pin a page that later hydrates a real document.
    // Usable-title gating (above) is what prevents false-clean on soft-walls.
    currentResponse = null;
  }
  return { clean: false, reason: lastReason, title: lastTitle };
}
