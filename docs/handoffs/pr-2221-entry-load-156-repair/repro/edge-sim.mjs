// Edge simulator for RCA repro: forwards to UPSTREAM, but the entry named by the HTML
// answers its first request with Vercel's immutable 404 (a node that served the freshly
// promoted HTML before it held the new assets; run 43691173465, sfo1::v84cb).
import http from 'node:http';
const UPSTREAM = process.env.UPSTREAM ?? 'https://www.roselabs.ai';
const PORT = Number(process.env.PORT ?? 4517);
let entry; let entryHits = 0;
http.createServer(async (req, res) => {
  const url = new URL(req.url, UPSTREAM);
  if (entry && url.pathname === entry && entryHits++ === 0) {
    console.log('edge-404', url.pathname);
    res.writeHead(404, { 'cache-control': 'public, max-age=31536000, immutable', 'content-type': 'text/plain' });
    return res.end('The page could not be found');
  }
  try {
    const up = await fetch(url, { headers: { accept: req.headers.accept ?? '*/*' }, redirect: 'manual' });
    let body = Buffer.from(await up.arrayBuffer());
    if (!entry && (up.headers.get('content-type') ?? '').includes('text/html')) {
      const m = [...body.toString().matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g)];
      entry = new URL(m[m.length - 1][1], UPSTREAM).pathname; console.log('entry', entry);
    }
    const h = {}; up.headers.forEach((v, k) => { if (!['connection','content-encoding','content-length','transfer-encoding'].includes(k)) h[k] = v; });
    res.writeHead(up.status, h); res.end(body);
  } catch { res.writeHead(502); res.end(); }
}).listen(PORT, '127.0.0.1', () => console.log('listening', PORT));
