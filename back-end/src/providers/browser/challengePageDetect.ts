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
// Present on hard CF walls *and* on cleared pages that embed Bot Management /
// Turnstile (Eventim ticket HTML). Only count when visible body is still sparse.
const HTML_CHALLENGE_MARKERS = [
  '/cdn-cgi/challenge-platform',
  'cf-chl-',
  'challenges.cloudflare.com/turnstile',
];
const SUBSTANTIVE_BODY_CHARS = 80;

export function challengeDetectionReason(input: {
  status: number | null;
  title: string;
  bodyText: string;
  html: string;
}): string | null {
  if (input.status === 403 || input.status === 429) return `status_${input.status}`;
  const content = `${input.title}\n${input.bodyText}`.toLowerCase();
  for (const marker of CHALLENGE_TEXT) {
    if (content.includes(marker)) return `text:${marker}`;
  }
  const html = input.html.toLowerCase();
  const visibleMarkup = html.replace(/<[^>]+>/g, '').trim();
  if (!input.title.trim() && !input.bodyText.trim() && !visibleMarkup) return 'empty_page';
  // Cleared Eventim pages embed challenge-platform/Turnstile beside real
  // inventory copy — do not treat those script URLs as a wall once body text
  // is substantive.
  if (input.bodyText.trim().length < SUBSTANTIVE_BODY_CHARS) {
    for (const marker of HTML_CHALLENGE_MARKERS) {
      if (html.includes(marker)) return `html:${marker}`;
    }
  }
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
  // assuming a fixed solve duration. A clean page exits immediately.
  const deadline = Date.now() + 45_000;
  let currentResponse = response;
  let lastReason: string | null = 'probe_timeout';
  let lastTitle = '';
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    const snapshot = await challengeSnapshot(page, currentResponse);
    lastTitle = snapshot.title;
    lastReason = challengeDetectionReason(snapshot);
    if (lastReason === null) return { clean: true, reason: null, title: lastTitle };
    currentResponse = null;
  }
  return { clean: false, reason: lastReason, title: lastTitle };
}
