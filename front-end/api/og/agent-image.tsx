import { ImageResponse } from '@vercel/og';
import { fetchAgentPreview, isAgentId, statusLine, type AgentPreview } from './_agentPreview.js';

export const config = { runtime: 'edge' };

const THEMES: Record<AgentPreview['state'], { background: string; accent: string }> = {
  started: { background: '#1f1e1c', accent: '#e7a36b' },
  done: { background: '#16302a', accent: '#6fd3a0' },
  stopped: { background: '#2a2622', accent: '#d8b37a' },
};

/** Titles are at most 80 characters; size them so every title fits in three lines. */
export function titleSize(title: string): number {
  const length = Array.from(title).length;
  if (length <= 28) return 76;
  if (length <= 50) return 64;
  return 54;
}

/** /api/og/agent-image?agent-id=… — the 1200×630 link-preview image for an agent. */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const agentId = url.searchParams.get('agent-id');
  const preview = isAgentId(agentId) ? await fetchAgentPreview(agentId) : null;
  if (!preview) return Response.redirect(`${url.origin}/social/opengraph-1200x630.jpg`, 302);
  const theme = THEMES[preview.state];
  const status = statusLine(preview).toUpperCase();

  return new ImageResponse(
    <div
      style={{
        width: '1200px',
        height: '630px',
        display: 'flex',
        flexDirection: 'column',
        padding: '68px 76px',
        background: theme.background,
        color: '#f4f2ee',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
        <img
          src={`${url.origin}/apple-touch-icon.png`}
          width={64}
          height={64}
          style={{ borderRadius: '16px' }}
        />
        <span style={{ fontSize: '34px', fontWeight: 600 }}>Rose</span>
      </div>
      <div
        style={{
          display: 'flex',
          marginTop: '64px',
          fontSize: '30px',
          fontWeight: 700,
          letterSpacing: '0.04em',
          color: theme.accent,
        }}
      >
        {status}
      </div>
      <div
        style={{
          display: 'block',
          marginTop: '18px',
          fontSize: `${titleSize(preview.title)}px`,
          fontWeight: 700,
          lineHeight: 1.12,
          lineClamp: 3,
          overflow: 'hidden',
        }}
      >
        {preview.title}
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      // The state is part of the URL, so a cached image never shows a stale state.
      headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
    },
  );
}
