// Live: Cerebras forced to 429, real OpenRouter fallback legs, exact router request.
import { readFileSync } from 'node:fs';
process.loadEnvFile('/home/boxes/rose/back-end/.env');
const { createStreamingCompletion } = await import('/home/boxes/rose/back-end/src/providers/rose/index.ts');
const { CEREBRAS_API_URL } = await import('/home/boxes/rose/back-end/src/providers/rose/transport.ts');
const [dumpPath, nArg, replacement] = process.argv.slice(2);
const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
const messages = dump.messages.map((m: any, i: number) => (replacement && i === 1 && m.role === 'user' ? { ...m, content: replacement } : m));
const req = dump.config.requested_params;
const real = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input.toString();
  if (url === CEREBRAS_API_URL) return new Response('{"message":"token quota exceeded"}', { status: 429 });
  return real(input, init);
}) as typeof fetch;
const out: any[] = [];
async function one(i: number) {
  const t0 = Date.now(); let text = '', model = '';
  try {
    for await (const c of (await createStreamingCompletion({ model: 'rose-labs/rose-1-flash', messages, temperature: 0, max_tokens: 2048, effort: 'minimal', response_format: req.response_format, provider_route: 'direct-cerebras', abort_signal: AbortSignal.timeout(15000) } as any)) as any) {
      text += c.choices?.[0]?.delta?.content ?? ''; model = c.actual_model ?? model;
    }
    let action = 'PARSE_ERROR'; try { action = JSON.parse(text).action; } catch {}
    out.push({ i, ms: Date.now() - t0, model, action });
  } catch (e: any) { out.push({ i, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 120) }); }
}
const n = Number(nArg);
for (let i = 0; i < n; i += 3) await Promise.all([0, 1, 2].filter((k) => i + k < n).map((k) => one(i + k)));
for (const r of out) console.log(JSON.stringify(r));
const ms = out.filter((r) => !r.error).map((r) => r.ms).sort((a, b) => a - b);
console.log(JSON.stringify({ n, ok: ms.length, closed: out.filter((r) => r.action && r.action !== 'PARSE_ERROR').length, over13s: out.filter((r) => r.ms > 13000).length, p50: ms[Math.floor(ms.length / 2)], max: ms[ms.length - 1] }));
process.exit(0);
