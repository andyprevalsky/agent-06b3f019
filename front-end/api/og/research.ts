import { getBlogMeta } from './_blogMeta.js';

export const config = { runtime: 'edge' };

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug');

  const html = await fetchIndexHtml(url.origin);

  if (!slug) {
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const post = getBlogMeta(slug);
  if (!post) {
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // `v` bypasses the empty images cached while the renderer ran on the edge runtime.
  const ogImageUrl = `${url.origin}/api/og/image?slug=${encodeURIComponent(slug)}&v=2`;
  const postUrl = `${url.origin}/research/${slug}`;
  const safeTitle = escapeHtml(post.title);
  const safeDesc = escapeHtml(post.description);

  const modified = html
    // Title tag
    .replace(/<title>[^<]*<\/title>/, `<title>${safeTitle} | Rose Labs</title>`)
    // Basic meta
    .replace(
      /<meta name="description" content="[^"]*" \/>/,
      `<meta name="description" content="${safeDesc}" />`,
    )
    .replace(
      /<link rel="canonical" href="[^"]*" \/>/,
      `<link rel="canonical" href="${postUrl}" />`,
    )
    // Open Graph
    .replace(
      /<meta property="og:title" content="[^"]*" \/>/,
      `<meta property="og:title" content="${safeTitle}" />`,
    )
    .replace(
      /<meta property="og:description" content="[^"]*" \/>/,
      `<meta property="og:description" content="${safeDesc}" />`,
    )
    .replace(
      /<meta property="og:type" content="[^"]*" \/>/,
      `<meta property="og:type" content="article" />`,
    )
    .replace(
      /<meta property="og:url" content="[^"]*" \/>/,
      `<meta property="og:url" content="${postUrl}" />`,
    )
    .replace(
      /<meta property="og:image" content="[^"]*" \/>/,
      `<meta property="og:image" content="${ogImageUrl}" />`,
    )
    .replace(
      /<meta property="og:image:secure_url" content="[^"]*" \/>/,
      `<meta property="og:image:secure_url" content="${ogImageUrl}" />`,
    )
    // Twitter
    .replace(
      /<meta name="twitter:image" content="[^"]*" \/>/,
      `<meta name="twitter:image" content="${ogImageUrl}" />`,
    )
    // Remove video meta tags for blog posts (they'd show the homepage video instead of the OG image)
    .replace(/<meta property="og:video[^"]*" content="[^"]*" \/>\n?\s*/g, '');

  return new Response(modified, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
    },
  });
}

async function fetchIndexHtml(origin: string): Promise<string> {
  const res = await fetch(`${origin}/index.html`);
  return res.text();
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
