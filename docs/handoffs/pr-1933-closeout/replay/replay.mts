// Replay the captured chat_router_after_search call through the production Rose client.
// usage: node --import tsx replay.ts <dump.json> <N> [replacementUserText]
import { readFileSync } from 'node:fs';
process.loadEnvFile('/home/boxes/rose/back-end/.env');
const { createStreamingCompletion } = await import('/home/boxes/rose/back-end/src/providers/rose/index.ts');
const [dumpPath, nArg, replacement] = process.argv.slice(2);
const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
const messages = dump.messages.map((m: any, i: number) =>
  replacement && i === 1 && m.role === 'user' ? { ...m, content: replacement } : m,
);
const req = dump.config.requested_params;
const n = Number(nArg);
const tally: Record<string, number> = {};
const models: Record<string, number> = {};
async function one(i: number) {
  let out = ''; let model = '';
  const stream = await createStreamingCompletion({
    model: 'rose-labs/rose-1-flash', messages, temperature: 0, max_tokens: 2048, effort: 'minimal',
    response_format: req.response_format, speed: req.speed, provider_route: req.provider_route,
    dump_context: { agent_id: `replay-${i}`, call_site: 'chat_router_after_search' },
  } as any);
  for await (const c of stream as any) {
    out += c.choices?.[0]?.delta?.content ?? '';
    model = c.actual_model ?? c.model ?? model;
  }
  let action = 'PARSE_ERROR';
  try { action = JSON.parse(out).action; } catch {}
  tally[action] = (tally[action] ?? 0) + 1; models[model] = (models[model] ?? 0) + 1;
  if (action !== 'direct_answer') console.log(`#${i} ${action} ${model} :: ${out.slice(0, 260).replace(/\s+/g, ' ')}`);
}
for (let i = 0; i < n; i += 4) await Promise.all([0, 1, 2, 3].filter((k) => i + k < n).map((k) => one(i + k)));
console.log(JSON.stringify({ n, tally, models }));
process.exit(0);
