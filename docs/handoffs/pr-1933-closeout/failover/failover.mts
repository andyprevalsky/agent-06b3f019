// Replay a captured chat_router request through the production OpenRouter failover body.
// usage: node --import tsx failover.mts <dump.json> <N> <provider|default> [replacementUserText]
import { readFileSync } from 'node:fs';
process.loadEnvFile('/home/boxes/rose/back-end/.env');
const { buildOpenRouterFastChatBody } = await import('/home/boxes/rose/back-end/src/providers/rose/openrouterFastRoute.ts');
const [dumpPath, nArg, provider, replacement] = process.argv.slice(2);
const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
const messages = dump.messages.map((m: any, i: number) => (replacement && i === 1 && m.role === 'user' ? { ...m, content: replacement } : m));
const req = dump.config.requested_params;
const results: any[] = [];
async function one(i: number) {
  const body: any = buildOpenRouterFastChatBody({ model: 'rose-labs/rose-1-flash', messages, temperature: 0, max_tokens: 2048, effort: 'minimal', response_format: req.response_format } as any, `replay-${Date.now()}-${i}`);
  if (provider !== 'default') body.provider = { ...body.provider, order: [provider], allow_fallbacks: false, ignore: [] , sort: undefined};
  const t0 = Date.now(); let content = '', reasoning = '', host = '', chunks = 0, first = 0;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', signal: ctl.signal, headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { results.push({ i, status: res.status, err: (await res.text()).slice(0, 200) }); return; }
    const dec = new TextDecoder(); let buf = '';
    for await (const part of res.body as any) {
      buf += dec.decode(part, { stream: true });
      let k; while ((k = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1);
        if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
        try { const j = JSON.parse(line.slice(5)); host = j.provider || host; const d = j.choices?.[0]?.delta || {}; if (d.content) { content += d.content; if (!first) first = Date.now() - t0; } if (d.reasoning) reasoning += d.reasoning; chunks++; } catch {}
      }
    }
  } catch (e: any) { results.push({ i, host, ms: Date.now() - t0, aborted: true, chunks, contentLen: content.length, reasoningLen: reasoning.length, head: content.slice(0, 300), tail: content.slice(-200) }); return; } finally { clearTimeout(timer); }
  let keys: string[] = [], action = 'PARSE_ERROR';
  try { const o = JSON.parse(content); keys = Object.keys(o); action = o.action; } catch {}
  results.push({ i, host, ms: Date.now() - t0, firstContentMs: first, chunks, contentLen: content.length, reasoningLen: reasoning.length, action, actionIdx: keys.indexOf('action') });
}
const n = Number(nArg);
for (let i = 0; i < n; i += 3) await Promise.all([0, 1, 2].filter((k) => i + k < n).map((k) => one(i + k)));
for (const r of results) console.log(JSON.stringify(r));
const ms = results.filter((r) => r.ms).map((r) => r.ms).sort((a, b) => a - b);
console.log(JSON.stringify({ provider, n, over13s: ms.filter((m) => m > 13000).length, p50: ms[Math.floor(ms.length / 2)], max: ms[ms.length - 1] }));
process.exit(0);
