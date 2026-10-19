/* RCA scratch: replay the fill-form benchmark turn against the LOCAL victoria DB (seeded by
 * seed_local.py) through Rose.complete, recording every round's raw model output.
 * Mirrors supervisorHandler.ts message assembly and per-round feedback; writes are recorded,
 * never committed. Env: DATABASE_URL/DIRECT_URL must point at local victoria; RCA_MODEL (alias);
 * RCA_N trials; RCA_CONC parallelism. */
import 'dotenv/config';
import fs from 'node:fs';

const USER = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const INBOUND = 'Filled it for me';
const VALUES = ['G58219473', '72914836'];

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '')) throw new Error('DATABASE_URL must be local');
  const label = process.argv[2] ?? 'local';
  const n = Number(process.env.RCA_N ?? '4');
  const conc = Number(process.env.RCA_CONC ?? '2');
  const model = process.env.RCA_MODEL ?? 'rose-labs/rose-1-ultra';
  const { registerUserDataGrep } = await import('../../../back-end/src/providers/userDataSearch');
  const { grep: userDataGrep } = await import('../../../back-end/src/domains/data/service');
  registerUserDataGrep(userDataGrep);
  const { createStreamingCompletion, markCacheable } = await import('../../../back-end/src/providers/rose');
  const { StructuredOutputAccumulator } = await import('../../../back-end/src/providers/rose/structuredOutput');
  const { SUPERVISOR_RESPONSE_MODEL } = await import('../../../back-end/src/providers/smsSupervisor/schema');
  const { finalizeSupervisorResponse } = await import('../../../back-end/src/providers/smsSupervisor/supervisorLlm');
  const { executeGrepTool } = await import('../../../back-end/src/providers/smsSupervisor/supervisorTools.grep');
  const { executeWebSearchTool } = await import('../../../back-end/src/providers/smsSupervisor/supervisorTools.webSearch');
  const env = await import('../../../back-end/src/providers/smsSupervisor/environmentMessages');

  const ctx = await env.prepareSmsEnvironment(USER, 31, false, INBOUND);
  const base = [
    markCacheable(ctx.systemPrompt),
    ...ctx.sessionHistory,
    { role: 'user' as const, content: INBOUND },
    ...env.buildEnvironmentToolMessages(ctx.contextUserMessage, 31),
  ];
  console.log(`context: history=${ctx.sessionHistory.length} env=${ctx.contextUserMessage.length} system=${ctx.systemPrompt.length}`);

  const one = async (i: number) => {
    const messages = JSON.parse(JSON.stringify(base));
    const rounds: Array<Record<string, unknown>> = [];
    let sent = 0;
    for (let round = 0; round < 6; round++) {
      const stream = await createStreamingCompletion({ model, messages, temperature: 0.3, response_model: SUPERVISOR_RESPONSE_MODEL });
      const acc = new StructuredOutputAccumulator();
      let reasoning = '';
      let actual = '';
      for await (const chunk of stream) {
        const c = chunk.choices?.[0];
        if (c?.delta?.content) acc.addCompletionChunk(chunk);
        if (c?.delta?.reasoning) reasoning += c.delta.reasoning;
        if (chunk.actual_model) actual = chunk.actual_model;
      }
      const raw = acc.currentText();
      const r = finalizeSupervisorResponse([], acc, reasoning);
      const results: Array<{ tool: string; success: boolean; result: string; error?: string }> = [];
      const calls: Array<Record<string, unknown>> = [];
      let done = false;
      for (const tc of r.tool_calls) {
        const a = tc.arguments as Record<string, unknown>;
        if (tc.tool === 'grep') {
          const g = await executeGrepTool(a as never, USER);
          calls.push({ tool: 'grep', pattern: a.pattern, source: a.source, hit: VALUES.some((v) => g.result.includes(v)) });
          results.push(g);
        } else if (tc.tool === 'web_search') {
          calls.push({ tool: 'web_search', query: a.query });
          results.push(await executeWebSearchTool(a as never));
        } else if (tc.tool === 'send_user_message') {
          sent++;
          calls.push({ tool: 'send_user_message', message: String(a.message) });
          results.push({ tool: 'send_user_message', success: true, result: 'SMS sent and persisted' });
        } else if (tc.tool === 'start_new_agent') {
          const budget = Number(a.budget_dollars ?? 1);
          const ok = !(budget > 2);
          calls.push({ tool: 'start_new_agent', goal: String(a.goal), budget, ok });
          results.push(
            ok
              ? { tool: 'start_new_agent', success: true, result: `queued: will start agent [sim${i}${round}] for "${String(a.goal).slice(0, 80)}"` }
              : { tool: 'start_new_agent', success: false, result: '', error: 'budget_dollars is the agent-run LLM/tool budget (default $1, max $2), NOT the purchase price. Purchases are approved separately via attention requests. Retry with budget_dollars <= 2.' }
          );
        } else if (tc.tool === 'attempt_completion') {
          calls.push({ tool: 'attempt_completion', accepted: sent > 0 });
          if (sent > 0) done = true;
          else results.push({ tool: 'attempt_completion', success: false, result: '', error: 'Rejected: this run has not successfully called send_user_message' });
        } else {
          calls.push({ tool: tc.tool, args: a });
          results.push({ tool: tc.tool, success: true, result: 'recorded (replay)' });
        }
      }
      rounds.push({ round, actual, raw, calls });
      if (done) break;
      if (r.tool_calls.length === 0) {
        const empties = rounds.filter((x) => (x.calls as unknown[]).length === 0).length;
        if (empties >= 2 && (rounds.at(-2)?.calls as unknown[])?.length === 0) break;
      }
      const summary = results.map((x) => `[${x.tool}] ${x.success ? 'OK' : 'ERROR'}: ${x.result || x.error}`).join('\n');
      messages.push(
        ...env.buildToolFeedbackMessages({
          round,
          assistantPayload: JSON.stringify({ reasoning: r.reasoning, tool_calls: r.tool_calls }),
          toolResultSummary: r.tool_calls.length ? `Tool results:\n${summary}` : '',
          guidance: r.tool_calls.length
            ? 'Incorporate these results. Use send_user_message only for text the user still needs, and call argument-free attempt_completion as soon as the run is complete.'
            : sent === 0
              ? 'That response contained no tool calls, so nothing reached the user. They texted you and are waiting on an answer; staying silent is not an option this run. Call send_user_message once with a short reply in your own words, then attempt_completion.'
              : 'That response contained no tool calls. This run has already replied, so call argument-free attempt_completion now.',
        })
      );
    }
    const all = rounds.flatMap((x) => x.calls as Array<Record<string, unknown>>);
    const agentGoals = all.filter((c) => c.tool === 'start_new_agent' && c.ok).map((c) => String(c.goal));
    return {
      i,
      sent,
      found: all.some((c) => c.tool === 'grep' && c.hit),
      agent: agentGoals.length > 0,
      goalHasValues: VALUES.every((v) => agentGoals.join(' ').includes(v)),
      emptyRounds: rounds.filter((x) => (x.calls as unknown[]).length === 0).length,
      rounds,
    };
  };
  const runs: Array<Awaited<ReturnType<typeof one>>> = [];
  for (let k = 0; k < n; k += conc) runs.push(...(await Promise.all(Array.from({ length: Math.min(conc, n - k) }, (_, j) => one(k + j)))));
  fs.writeFileSync(`/home/boxes/rose/.context/rca-tamy-eta/localreplay/replay-${label}.json`, JSON.stringify(runs, null, 1));
  for (const r of runs) {
    console.log(`RUN ${r.i}: sent=${r.sent} found=${r.found} agent=${r.agent} goalHasValues=${r.goalHasValues} emptyRounds=${r.emptyRounds} served=${[...new Set(r.rounds.map((x) => x.actual))].join(',')}`);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
