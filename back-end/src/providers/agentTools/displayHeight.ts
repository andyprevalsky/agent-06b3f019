/**
 * Height reporting for framed `display` pages. The chat frames each page on the
 * cross-origin usercontent origin, so it cannot measure the page; agent-written
 * pages rarely report their own height. Every HTML response the display routes
 * serve ends with DISPLAY_HEIGHT_REPORTER, which posts the page's content height
 * to the frame (`rose:resize`, the same message rose-ui views send), so an
 * expanded display is as tall as its content and the chat, not the frame,
 * scrolls.
 *
 *   load / DOMContentLoaded / ResizeObserver(html, body)
 *     ─► own height < frame height ? own height : document scrollHeight
 *     ─► unchanged or < 8 px (only fixed / absolute content) → nothing sent
 *     ─► parent.postMessage({ type: 'rose:resize', height }, '*')
 *   frame height changed (window resize) and the content height changed with it
 *     ─► the layout follows the frame (100vh / height: 100%): no natural height,
 *        stop reporting so the frame keeps its current size instead of growing
 *        a step at a time
 *   opened top-level (no parent) ─► does nothing
 *
 * The stored, content-addressed bytes are unchanged; only the response gains
 * the script. 10k-agent behaviour: a constant append per HTML response.
 */

export const DISPLAY_HEIGHT_REPORTER = `<script data-rose-display-height>
(() => {
  if (window.parent === window) return;
  const root = document.documentElement;
  let measured = -1;
  let measuredAt = -1;
  let sent = -1;
  let frozen = false;
  const measure = () => {
    const own = Math.ceil(root.getBoundingClientRect().height);
    return own < innerHeight - 1 ? own : root.scrollHeight;
  };
  const report = () => {
    if (frozen) return;
    measured = measure();
    measuredAt = innerHeight;
    if (measured < 8 || measured === sent) return;
    sent = measured;
    parent.postMessage({ type: 'rose:resize', height: measured }, '*');
  };
  addEventListener('resize', () => {
    if (!frozen && measured >= 0 && innerHeight !== measuredAt && Math.abs(measure() - measured) > 1) {
      frozen = true;
    }
  });
  const start = () => {
    report();
    const observer = new ResizeObserver(report);
    observer.observe(root);
    if (document.body) observer.observe(document.body);
  };
  if (document.readyState === 'loading') {
    addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
  addEventListener('load', report);
})();
</script>
`;

/** The response body for a display file: HTML pages gain the height reporter. */
export function withDisplayHeightReporter(content: Buffer, contentType: string): Buffer {
  if (!contentType.startsWith('text/html')) return content;
  return Buffer.concat([content, Buffer.from(`\n${DISPLAY_HEIGHT_REPORTER}`)]);
}
