#!/usr/bin/env tsx
/**
 * One isolated "benchmark guest" backend for compute-token-authority.blackbox.ts.
 *
 * Each process binds Prisma to its own DATABASE_URL (as each cloud benchmark
 * guest binds to its own loopback Postgres) and serves the real compute-token
 * router on PORT. It prints `READY <port>` once listening.
 */
import express from 'express';
import computeRoutes from '../../domains/integrations/routes.compute';
import { foundryComplete, FOUNDRY_REGION_ENV_NAMES } from '../../providers/rose/foundry';
import { getPool } from '../../providers/rose/pools';
import { RoseServerError } from '../../providers/rose/errors';
import { createStreamingCompletion } from '../../providers/rose';

const app = express();
app.use(express.json({ type: 'application/json', limit: '1mb' }));
app.use('/api/integrations', computeRoutes);

// Exercise the real backend Foundry consumer while Azure itself is a local fixture.
app.post('/test-foundry', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.BACKEND_API_KEY) {
    res.sendStatus(401);
    return;
  }
  if (req.body.invalidHint) {
    const { InvalidFoundryCooldownRequest, markFoundryDeploymentCooldown } =
      await import('../../providers/foundryDeploymentCooldown');
    try {
      await markFoundryDeploymentCooldown(
        'overflow.example.test',
        'overflow',
        req.body.invalidHint
      );
      res.json({ rejected: false });
    } catch (error) {
      const invalidRequest = error instanceof InvalidFoundryCooldownRequest;
      res.status(invalidRequest ? 400 : 500).json({ invalidRequest });
    }
    return;
  }
  const original = global.fetch;
  const originalEnv = Object.fromEntries(
    [...FOUNDRY_REGION_ENV_NAMES, 'GPT_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'].map(
      (name) => [name, process.env[name]]
    )
  );
  const hits: string[] = [];
  const visible: string[] = [];
  let reports = 0;
  let resets = 0;
  let fallbackRequests = 0;
  for (const name of FOUNDRY_REGION_ENV_NAMES) delete process.env[name];
  process.env.AZURE_FOUNDRY_ENDPOINT = 'https://foundry-cta.example.test';
  process.env.AZURE_FOUNDRY_API_KEY = 'fixture';
  process.env.AZURE_FOUNDRY_DEPLOYMENTS = 'gpt-6-sol-a,gpt-6-sol-b';
  delete process.env.GPT_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.OPENROUTER_API_KEY = 'fixture';
  global.fetch = async (input, init) => {
    if (new URL(String(input)).host === 'openrouter.ai') {
      fallbackRequests++;
      return new Response(
        'data: {"choices":[{"delta":{"content":"fallback"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
      );
    }
    if (String(input).startsWith('https://foundry-cta.example.test/')) {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      hits.push(model);
      if (req.body.rejectKind === 'http') return new Response('', { status: 429 });
      const event =
        (req.body.reject === true || req.body.rejectKind) && hits.length === 1
          ? {
              type: 'response.failed',
              response: {
                error: { code: 'rate_limit_exceeded', message: 'Please try again in 900 seconds.' },
              },
            }
          : {
              type: 'response.completed',
              response: { usage: { input_tokens: 1, output_tokens: 1 } },
            };
      const content =
        req.body.rejectKind === 'visible'
          ? 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
          : event.type === 'response.completed'
            ? 'data: {"type":"response.output_text.delta","delta":"ok"}\n\n'
            : '';
      return new Response(content + 'data: ' + JSON.stringify(event) + '\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    const authority = process.env.COMPUTE_TOKEN_AUTHORITY_URL;
    if (authority && String(input).startsWith(authority + '/api/integrations/compute-code/')) {
      if (req.body.resetFailure && String(input).endsWith('/foundry-deployment/served')) {
        resets++;
        if (req.body.resetFailure === 'throw') throw new Error('fixture reset unavailable');
        return req.body.resetFailure === 'malformed'
          ? new Response('{}', { status: 200 })
          : new Response('', { status: 500 });
      }
      if (req.body.reportFailure && String(input).endsWith('/token/rate-limited')) {
        reports++;
        if (req.body.reportFailure === 'throw') throw new Error('fixture authority unavailable');
        return req.body.reportFailure === 'malformed'
          ? new Response('{}', { status: 200 })
          : new Response('', { status: 500 });
      }
      return original(input, init);
    }
    throw new Error(`Unexpected fixture outbound URL: ${String(input)}`);
  };
  try {
    const stream = req.body.waterfall
      ? await createStreamingCompletion({
          model: 'rose-labs/rose-1-ultra',
          messages: [{ role: 'user', content: 'hi' }],
          route_key: 'foundry-shared-cooldown-route',
        })
      : foundryComplete({
          poolSpec: getPool('rose-1-ultra'),
          messages: [{ role: 'user', content: 'hi' }],
          requestId: 'ts-cooldown-fixture',
          routeKey: 'foundry-shared-cooldown-route',
        });
    for await (const _chunk of stream) {
      if ('kind' in _chunk && _chunk.kind === 'content') visible.push(String(_chunk.data.text));
      else if ('choices' in _chunk) {
        const content = _chunk.choices[0]?.delta.content;
        if (typeof content === 'string') visible.push(content);
      }
    }
    res.json({ hits, reports, resets, visible, fallbackRequests });
  } catch (error) {
    res
      .status(500)
      .json({
        error: String(error),
        hits,
        reports,
        resets,
        visible,
        fallbackRequests,
        isRoseServerError: error instanceof RoseServerError,
      });
  } finally {
    global.fetch = original;
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

const server = app.listen(Number(process.env.PORT ?? '0'), '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  process.stdout.write(`READY ${port}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
