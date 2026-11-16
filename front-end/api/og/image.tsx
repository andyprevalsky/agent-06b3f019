import { ImageResponse } from '@vercel/og';
import { getBlogMeta } from './_blogMeta.js';

// Node runtime: Vercel's edge runtime refuses to compile @vercel/og's WebAssembly
// ("Wasm code generation disallowed by embedder"), so every edge render was an empty PNG.

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get('slug');

  if (!slug) {
    return new Response('Missing slug', { status: 400 });
  }

  const post = getBlogMeta(slug);
  if (!post) {
    return Response.redirect('https://roselabs.ai/social/opengraph-1200x630.jpg', 302);
  }

  return new ImageResponse(
    <div
      style={{
        width: '1200px',
        height: '630px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'flex-start',
        padding: '80px',
        background: 'linear-gradient(135deg, #ffffff 0%, #f8f8f8 100%)',
        fontFamily: 'Inter, sans-serif',
        position: 'relative',
      }}
    >
      {/* Rose Labs logo + wordmark */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '48px' }}>
        <div
          style={{
            width: '48px',
            height: '48px',
            borderRadius: '12px',
            background:
              'linear-gradient(to bottom left, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)',
          }}
        />
        <span
          style={{ fontSize: '32px', fontWeight: 600, color: '#0f172a', letterSpacing: '-0.02em' }}
        >
          Rose Labs
        </span>
      </div>

      {/* Blog post title */}
      <div
        style={{
          fontSize: '52px',
          fontWeight: 700,
          color: '#0f172a',
          lineHeight: 1.2,
          letterSpacing: '-0.02em',
          maxWidth: '1040px',
        }}
      >
        {post.title}
      </div>

      {/* Category + date */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '48px' }}>
        <span
          style={{
            fontSize: '18px',
            fontWeight: 500,
            color: '#7A6BEC',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          {post.category}
        </span>
        <span style={{ fontSize: '18px', color: '#94a3b8' }}>|</span>
        <span style={{ fontSize: '18px', color: '#64748b' }}>{post.date}</span>
      </div>

      {/* Gradient accent bar at bottom */}
      <div
        style={{
          position: 'absolute',
          bottom: '0',
          left: '0',
          right: '0',
          height: '6px',
          background:
            'linear-gradient(to right, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)',
        }}
      />
    </div>,
    {
      width: 1200,
      height: 630,
      headers: {
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600',
      },
    },
  );
}
