/* RCA scratch v2: full-run dry replay of Tamara seq 8 with per-call served-model/pool/usage capture.
 * Env: RCA_MODEL (alias, default rose-labs/rose-1-flash), RCA_ROUTE (default|openrouter-waterfall|direct-cerebras),
 *      RCA_WATERFALL (comma list to replace flash waterfall), RCA_WF_EFFORT (override flash waterfallReasoningEffort),
 *      RCA_SCHEMA (live|unified), RCA_CONC (parallelism). Reads (grep, web_search) run read-only on prod data;
 *      writes are recorded only. Scoring is on the run's user-visible outcome. */
import 'dotenv/config';
import fs from 'node:fs';
import { z, type ZodObject, type ZodRawShape } from 'zod';
async function main() {
  const n = Number(process.argv[2] ?? '10'); const label = process.argv[3] ?? 'eval';
  const conc = Number(process.env.RCA_CONC ?? '5');
  const { POOL_REGISTRY } = await import('../../../back-end/src/providers/rose/pools');
  const flash = POOL_REGISTRY['rose-1-flash'] as { waterfall: readonly string[]; waterfallReasoningEffort?: string };
  if (process.env.RCA_WATERFALL) flash.waterfall = process.env.RCA_WATERFALL.split(',');
  if (process.env.RCA_WF_EFFORT) flash.waterfallReasoningEffort = process.env.RCA_WF_EFFORT;
  const { registerUserDataGrep } = await import('../../../back-end/src/providers/userDataSearch');
  const { grep: userDataGrep } = await import('../../../back-end/src/domains/data/service');
  registerUserDataGrep(userDataGrep);
  const { createStreamingCompletion, responseModel } = await import('../../../back-end/src/providers/rose');
  const { StructuredOutputAccumulator } = await import('../../../back-end/src/providers/rose/structuredOutput');
  const { SUPERVISOR_RESPONSE_MODEL, SmsSupervisorToolCallSchema, SmsSupervisorResponseSchema } = await import('../../../back-end/src/providers/smsSupervisor/schema');
  const { TOOL_SCHEMAS } = await import('../../../back-end/src/providers/smsSupervisor/supervisorTools.schemas');
  const { finalizeSupervisorResponse } = await import('../../../back-end/src/providers/smsSupervisor/supervisorLlm');
  const { executeGrepTool } = await import('../../../back-end/src/providers/smsSupervisor/supervisorTools.grep');
  const { executeWebSearchTool } = await import('../../../back-end/src/providers/smsSupervisor/supervisorTools.webSearch');
  const env = await import('../../../back-end/src/providers/smsSupervisor/environmentMessages');
  let schema = SUPERVISOR_RESPONSE_MODEL;
  if (process.env.RCA_SCHEMA === 'unified') {
    const byName = new Map(TOOL_SCHEMAS.map((t) => [t.name, t]));
    const members = SmsSupervisorToolCallSchema.options.map((member) => {
      const obj = member as unknown as ZodObject<ZodRawShape>;
      const name = (obj.shape.tool as unknown as { value: string }).value;
      if (obj.description) return obj;
      const authored = byName.get(name); if (!authored) return obj;
      const args = obj.shape.arguments as unknown as ZodObject<ZodRawShape>;
      const props = authored.parameters.properties as Record<string, { description?: string }>;
      const shape: ZodRawShape = {};
      for (const [k, v] of Object.entries(args.shape)) { const d = props[k]?.description; shape[k] = d && !v.description ? v.describe(d) : v; }
      const newArgs = args._def.unknownKeys === 'strict' ? z.object(shape).strict() : z.object(shape);
      return z.object({ ...obj.shape, arguments: newArgs }).describe(authored.description);
    });
    const call = z.discriminatedUnion('tool', members as unknown as [ZodObject<ZodRawShape>, ZodObject<ZodRawShape>, ...ZodObject<ZodRawShape>[]]);
    schema = responseModel('sms_supervisor_response', z.object({ reasoning: SmsSupervisorResponseSchema.shape.reasoning, tool_calls: z.array(call).describe(SmsSupervisorResponseSchema.shape.tool_calls.description ?? '') }));
  }
  const route = process.env.RCA_ROUTE && process.env.RCA_ROUTE !== 'default' ? process.env.RCA_ROUTE as 'openrouter-waterfall' | 'direct-cerebras' : undefined;
  const model = process.env.RCA_MODEL ?? 'rose-labs/rose-1-flash';
  const base = JSON.parse(fs.readFileSync('/home/boxes/rose/.context/rca-tamy-eta/seq8-round0-messages.json', 'utf8'));
  if (process.env.RCA_DROP_FIRST_TURN === '1') {
    const line = '- Respond to the user on your first turn, failing to respond quickly risks disengagement from the user.\n';
    if (!base[0].content.includes(line)) throw new Error('first-turn line not found');
    base[0].content = base[0].content.replace(line, '');
  }
  const envText = base[base.length - 1].content as string;
  const userId = '43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9';
  const calls: Array<{ actual: string; pool: string; ms: number; usage?: unknown }> = [];
  const llm = async (messages: unknown[]) => {
    const t0 = Date.now();
    const stream = await createStreamingCompletion({ model, messages: messages as never, temperature: 0.3, response_model: schema, ...(route ? { provider_route: route } : {}) });
    const acc = new StructuredOutputAccumulator(); let reasoning = ''; let actual = ''; let pool = ''; let usage: unknown;
    const native: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
    for await (const chunk of stream) {
      const c = chunk.choices?.[0];
      if (c?.delta?.content) acc.addCompletionChunk(chunk);
      if (c?.delta?.reasoning) reasoning += c.delta.reasoning;
      for (const tc of c?.delta?.tool_calls ?? []) { const nm = tc.function?.name; if (!nm) continue; try { const pi = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; native.push({ tool: nm, arguments: (pi && typeof pi === 'object' && 'arguments' in pi ? pi.arguments : pi) ?? {} }); } catch { /* parse failure */ } }
      if (chunk.actual_model) actual = chunk.actual_model; if (chunk.pool_name) pool = chunk.pool_name; if (chunk.usage) usage = chunk.usage;
    }
    calls.push({ actual, pool, ms: Date.now() - t0, usage });
    return { r: finalizeSupervisorResponse(native as never, acc, reasoning), actual, pool };
  };
  const one = async (i: number) => {
    const messages = JSON.parse(JSON.stringify(base));
    const trace: Array<Record<string, unknown>> = []; let sent = 0; let round0 = '';
    try {
      for (let round = 0; round < 6; round++) {
        const { r, actual, pool } = await llm(messages);
        if (round === 0) round0 = `${actual}@${pool}`;
        const results: Array<{ tool: string; success: boolean; result: string; error?: string }> = []; let done = false;
        if (r.tool_calls.length === 0) trace.push({ round, tool: '(none)' });
        for (const tc of r.tool_calls) {
          const a = tc.arguments as Record<string, unknown>;
          if (tc.tool === 'grep') { const g = await executeGrepTool(a as never, userId); trace.push({ round, tool: 'grep', pattern: a.pattern, source: a.source, matches: JSON.parse(g.result || '{}').total_matches }); results.push(g); }
          else if (tc.tool === 'web_search') { const w = await executeWebSearchTool(a as never); trace.push({ round, tool: 'web_search', query: a.query }); results.push(w); }
          else if (tc.tool === 'get_environment') { trace.push({ round, tool: 'get_environment' }); results.push({ tool: 'get_environment', success: true, result: envText }); }
          else if (tc.tool === 'send_user_message') { sent++; trace.push({ round, tool: 'send_user_message', message: String(a.message) }); results.push({ tool: 'send_user_message', success: true, result: 'SMS sent and persisted' }); }
          else if (tc.tool === 'start_new_agent') { trace.push({ round, tool: 'start_new_agent', goal: String(a.goal), start_phase: a.start_phase }); results.push({ tool: 'start_new_agent', success: true, result: 'Queued: agent will start when this run completes' }); }
          else if (tc.tool === 'attempt_completion') { trace.push({ round, tool: 'attempt_completion' }); if (sent > 0) done = true; else results.push({ tool: 'attempt_completion', success: false, result: '', error: 'Rejected: this run has not successfully called send_user_message' }); }
          else { trace.push({ round, tool: tc.tool, args: a }); results.push({ tool: tc.tool, success: true, result: 'recorded (dry run)' }); }
        }
        if (done) break;
        const summary = results.map((x) => `[${x.tool}] ${x.success ? 'OK' : 'ERROR'}: ${x.result || x.error}`).join('\n');
        messages.push(...env.buildToolFeedbackMessages({ round, assistantPayload: JSON.stringify({ reasoning: r.reasoning, tool_calls: r.tool_calls }), toolResultSummary: r.tool_calls.length ? `Tool results:\n${summary}` : '', guidance: r.tool_calls.length ? 'Incorporate these results. Use send_user_message only for text the user still needs, and call argument-free attempt_completion as soon as the run is complete.' : (sent === 0 ? 'That response contained no tool calls, so nothing reached the user. They texted you and are waiting on an answer; staying silent is not an option this run. Call send_user_message once with a short reply in your own words, then attempt_completion.' : 'That response contained no tool calls. This run has already replied, so call argument-free attempt_completion now.') }));
      }
    } catch (e) { trace.push({ error: String(e).slice(0, 300) }); }
    const sends = trace.filter((t) => t.tool === 'send_user_message').map((t) => String(t.message));
    const firstSendIdx = trace.findIndex((t) => t.tool === 'send_user_message');
    const before = trace.slice(0, firstSendIdx < 0 ? trace.length : firstSendIdx);
    const delegated = trace.some((t) => t.tool === 'start_new_agent');
    const searchedFirst = before.some((t) => t.tool === 'grep');
    const errored = trace.some((t) => 'error' in t);
    // Re-ask of contact facts already in # User Context (email/phone). "Full name (as in passport)" is legitimate and not counted.
    const reaskContact = sends.some((m) => /\b(e-?mail|phone( number)?)\b/i.test(m) && !/your (e-?mail|phone)[^.?\n]*(on file|i have)/i.test(m));
    const outcome = errored ? 'ERROR' : delegated ? 'DELEGATED' : searchedFirst ? 'SEARCHED_THEN_ASKED' : sends.length ? 'ASKED_WITHOUT_TRYING' : 'NO_REPLY';
    return { i, round0, outcome, reaskContact, sends: sends.map((m) => m.slice(0, 400)), trace };
  };
  const runs: Array<Awaited<ReturnType<typeof one>>> = [];
  for (let k = 0; k < n; k += conc) runs.push(...(await Promise.all(Array.from({ length: Math.min(conc, n - k) }, (_, j) => one(k + j)))));
  const count = (o: string) => runs.filter((r) => r.outcome === o).length;
  const fail = runs.filter((r) => r.outcome === 'ASKED_WITHOUT_TRYING' || r.reaskContact).length;
  const served: Record<string, number> = {}; for (const r of runs) served[r.round0] = (served[r.round0] ?? 0) + 1;
  const ms = calls.map((c) => c.ms).sort((a, b) => a - b);
  const out = { label, n, fail, ASKED_WITHOUT_TRYING: count('ASKED_WITHOUT_TRYING'), SEARCHED_THEN_ASKED: count('SEARCHED_THEN_ASKED'), DELEGATED: count('DELEGATED'), NO_REPLY: count('NO_REPLY'), ERROR: count('ERROR'), reaskContact: runs.filter((r) => r.reaskContact).length, round0_served: served, call_p50_ms: ms[Math.floor(ms.length / 2)], call_p95_ms: ms[Math.floor(ms.length * 0.95)], call_max_ms: ms[ms.length - 1] };
  fs.writeFileSync(`/home/boxes/rose/.context/rca-tamy-eta/eval-${label}.json`, JSON.stringify({ summary: out, calls, runs }, null, 1));
  console.log('EVAL ' + JSON.stringify(out));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
