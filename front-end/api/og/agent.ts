import { fetchAgentPreview, isAgentId, statusLine } from './_agentPreview.js';

export const config = { runtime: 'edge' };

/** /a/<agent-id>: the app page with that agent's link-preview tags. */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const agentId = url.searchParams.get('agent-id');
  const html = await (await fetch(`${url.origin}/index.html`)).text();
  if (!isAgentId(agentId)) return htmlResponse(html);

  // The app opens agents from ?agent-id; restore that URL before it boots.
  const restore = `<script>history.replaceState(null,'','/?agent-id=${agentId}')</script>`;
  const withRestore = html.replace('<head>', `<head>${restore}`);
  const preview = await fetchAgentPreview(agentId);
  if (!preview) return htmlResponse(withRestore);

  const title = escapeHtml(preview.title);
  const description = escapeHtml(statusLine(preview));
  const image = `${url.origin}/api/og/agent-image?agent-id=${agentId}&state=${preview.state}`;
  const pageUrl = `${url.origin}/a/${agentId}`;
  let tagged = withRestore.replace(/<title>[^<]*<\/title>/, `<title>${title} | Rose</title>`);
  for (const [attribute, key, value] of [
    ['property', 'og:title', title],
    ['property', 'og:description', description],
    ['property', 'og:url', pageUrl],
    ['property', 'og:image', image],
    ['property', 'og:image:secure_url', image],
    ['name', 'twitter:title', title],
    ['name', 'twitter:description', description],
    ['name', 'twitter:image', image],
  ] as const) {
    tagged = setMeta(tagged, attribute, key, value);
  }
  // The homepage video would replace the agent image in previews.
  tagged = tagged.replace(/<meta\s+property="og:video[^"]*"\s+content="[^"]*"\s*\/>\n?\s*/g, '');
  return htmlResponse(tagged);
}

/** Tags in index.html may wrap across lines; match attribute order with any whitespace. */
function setMeta(html: string, attribute: 'property' | 'name', key: string, value: string): string {
  const pattern = new RegExp(
    `<meta\\s+${attribute}="${key.replace(/[.:]/g, '\\$&')}"\\s+content="[^"]*"\\s*\\/>`,
  );
  return html.replace(pattern, `<meta ${attribute}="${key}" content="${value}" />`);
}

function htmlResponse(html: string): Response {
  // The agent's state changes over time; every fetch reads it fresh.
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
