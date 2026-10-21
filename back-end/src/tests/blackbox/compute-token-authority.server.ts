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

const app = express();
app.use(express.json({ type: 'application/json', limit: '1mb' }));
app.use('/api/integrations', computeRoutes);

// Exercise the real backend Foundry consumer while Azure itself is a local fixture.
app.post('/test-foundry', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.BACKEND_API_KEY) {
    res.sendStatus(401);
    return;
  }
  const original = global.fetch;
  const hits: string[] = [];
  for (const name of FOUNDRY_REGION_ENV_NAMES) delete process.env[name];
  process.env.AZURE_FOUNDRY_ENDPOINT = 'https://foundry-cta.example.test';
  process.env.AZURE_FOUNDRY_API_KEY = 'fixture';
  process.env.AZURE_FOUNDRY_DEPLOYMENTS = 'gpt-6-sol-a,gpt-6-sol-b';
  global.fetch = async (input, init) => {
    if (String(input).startsWith('https://foundry-cta.example.test/')) {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      hits.push(model);
      const event =
        req.body.reject === true && hits.length === 1
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
        event.type === 'response.completed'
          ? 'data: {"type":"response.output_text.delta","delta":"ok"}\n\n'
          : '';
      return new Response(content + 'data: ' + JSON.stringify(event) + '\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    const authority = process.env.COMPUTE_TOKEN_AUTHORITY_URL;
    if (authority && String(input).startsWith(authority + '/api/integrations/compute-code/'))
      return original(input, init);
    throw new Error(`Unexpected fixture outbound URL: ${String(input)}`);
  };
  try {
    for await (const _chunk of foundryComplete({
      poolSpec: getPool('rose-1-ultra'),
      messages: [{ role: 'user', content: 'hi' }],
      requestId: 'ts-cooldown-fixture',
      routeKey: 'foundry-shared-cooldown-route',
    })) {
      void _chunk; // Drain the actual consumer through terminal completion.
    }
    res.json({ hits });
  } catch (error) {
    res.status(500).json({ error: String(error), hits });
  } finally {
    global.fetch = original;
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
