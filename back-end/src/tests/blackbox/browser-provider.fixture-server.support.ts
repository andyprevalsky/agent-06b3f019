/** Real browser routes with an explicit deployment provider in this isolated test process. */
import express from 'express';
import { ZodError } from 'zod';
import browserRoutes from '../../domains/browser-session/routes';
import type { BrowserProviderName } from '../../providers/browser/types';

export async function withBrowserProviderServer(
  provider: BrowserProviderName,
  run: () => Promise<void>
): Promise<void> {
  if (!process.env.TEST_BASE_URL) return;
  const previous = {
    TEST_BASE_URL: process.env.TEST_BASE_URL,
    BROWSER_PROVIDER: process.env.BROWSER_PROVIDER,
    BROWSER_AGENT_TILION_ENABLED: process.env.BROWSER_AGENT_TILION_ENABLED,
  };
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/browser-session', browserRoutes);
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error instanceof ZodError ? 400 : 500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  );
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Missing provider fixture listener');
    process.env.TEST_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.BROWSER_PROVIDER = provider;
    process.env.BROWSER_AGENT_TILION_ENABLED = 'true';
    await run();
  } finally {
    try {
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
}
