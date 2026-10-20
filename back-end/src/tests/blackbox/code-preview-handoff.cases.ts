/**
 * code-preview blackbox cases for the one-time preview sign-in (L-APPS2).
 * Registered by code-preview.blackbox.ts.
 *
 *   owner's real session ─POST /:taskId/preview/handoff─► { code, expires_at, preview_url }
 *   preview origin ─POST /api/preview-handoff/redeem {code}─► 8 h session, amr preview_handoff
 *
 * Invariants: dev accounts only; the task owner's own login session only (API
 * key, impersonation and preview sessions → USER_SESSION_REQUIRED); a foreign
 * task is 404; a code is single-use, expires after 60 s, is stored as SHA-256
 * only, and is bound to the preview origin the server resolved (a wrong origin
 * burns it); the redeemed session works, never refreshes and cannot mint
 * another handoff; the redeem route answers CORS for preview origins only.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import { prisma } from '../../providers/database';

export interface PreviewHandoffCaseContext {
  baseUrl: string;
  apiKey: string;
  devUser: string;
  otherUser: string;
  agentFor: (userId: string) => Promise<string>;
  codeSessionRow: (
    userId: string,
    agentId: string,
    data: { sandboxId?: string; repoUrl?: string; sandboxKind?: string; homeDir?: string }
  ) => Promise<{ id: string }>;
  taskRow: (
    agentId: string,
    data: { sandboxId: string; streamUrl: string; codeSessionId: string | null }
  ) => Promise<string>;
}

interface Res {
  status: number;
  data: Record<string, unknown>;
  headers: Headers;
}

const EIGHT_HOURS = 8 * 60 * 60;

function signingEnv(): { secret: string; issuer: string } {
  const secret = process.env.SUPABASE_JWT_SECRET;
  const url = process.env.SUPABASE_URL;
  assert.ok(secret && url, 'SUPABASE_JWT_SECRET and SUPABASE_URL are required');
  return { secret, issuer: `${url}/auth/v1` };
}

/** A login JWT shaped like the backend's OTP session (no phone: no phone sync). */
function userJwt(userId: string, extra: Record<string, unknown> = {}): string {
  const { secret, issuer } = signingEnv();
  return jwt.sign(
    {
      sub: userId,
      aud: 'authenticated',
      role: 'authenticated',
      is_anonymous: false,
      amr: [{ method: 'otp', timestamp: Math.floor(Date.now() / 1000) }],
      ...extra,
    },
    secret,
    { algorithm: 'HS256', issuer, expiresIn: '1h' }
  );
}

async function send(
  baseUrl: string,
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: unknown } = {}
): Promise<Res> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...init.headers },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data, headers: response.headers };
}

export function previewHandoffCases(ctx: PreviewHandoffCaseContext): void {
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const mint = (taskId: string, headers: Record<string, string>) =>
    send(ctx.baseUrl, 'POST', `/api/claude-code-session/${taskId}/preview/handoff`, { headers });
  const redeem = (code: unknown, origin?: string) =>
    send(ctx.baseUrl, 'POST', '/api/preview-handoff/redeem', {
      headers: origin !== undefined ? { Origin: origin } : {},
      body: { code },
    });

  /** A dev-owned cloud task whose preview is https://5173-<sandbox>.e2b.invalid/. */
  async function devCloudTask(): Promise<{ taskId: string; origin: string }> {
    const agentId = await ctx.agentFor(ctx.devUser);
    const sandboxId = `sbx${randomUUID().slice(0, 8)}`;
    const session = await ctx.codeSessionRow(ctx.devUser, agentId, {
      sandboxId,
      repoUrl: 'https://github.com/Rose-Ai-Labs/rose',
    });
    const taskId = await ctx.taskRow(agentId, {
      sandboxId,
      streamUrl: `wss://3000-${sandboxId}.e2b.invalid`,
      codeSessionId: session.id,
    });
    return { taskId, origin: `https://5173-${sandboxId}.e2b.invalid` };
  }

  async function mintCode(taskId: string): Promise<string> {
    const minted = await mint(taskId, bearer(userJwt(ctx.devUser)));
    assert.equal(minted.status, 201, JSON.stringify(minted.data));
    return String(minted.data.code);
  }

  test('preview handoff: only the task owner’s own dev login session can mint', async () => {
    const { taskId } = await devCloudTask();
    const noAuth = await mint(taskId, {});
    assert.equal(noAuth.status, 401, JSON.stringify(noAuth.data));
    const apiKey = await mint(taskId, { 'X-API-Key': ctx.apiKey, 'X-User-Id': ctx.devUser });
    assert.equal(apiKey.status, 403, JSON.stringify(apiKey.data));
    assert.equal(apiKey.data.code, 'USER_SESSION_REQUIRED', 'API keys are refused');
    const impersonated = await mint(
      taskId,
      bearer(userJwt(ctx.devUser, { act: { sub: ctx.otherUser } }))
    );
    assert.equal(impersonated.status, 403, JSON.stringify(impersonated.data));
    assert.equal(impersonated.data.code, 'USER_SESSION_REQUIRED', 'impersonation is refused');

    const otherAgent = await ctx.agentFor(ctx.otherUser);
    const otherTask = await ctx.taskRow(otherAgent, {
      sandboxId: 'sbxhandoffother',
      streamUrl: 'wss://3000-sbxhandoffother.e2b.invalid',
      codeSessionId: null,
    });
    const nonDev = await mint(otherTask, bearer(userJwt(ctx.otherUser)));
    assert.equal(nonDev.status, 403, JSON.stringify(nonDev.data));
    assert.equal(nonDev.data.code, 'ROSE_DEV_ONLY', 'non-dev accounts, even for their own task');
    const foreign = await mint(otherTask, bearer(userJwt(ctx.devUser)));
    assert.equal(foreign.status, 404, `another user's task: ${JSON.stringify(foreign.data)}`);
    const unknown = await mint(randomUUID(), bearer(userJwt(ctx.devUser)));
    assert.equal(unknown.status, 404);
    assert.equal(
      await prisma.previewHandoffCode.count({ where: { taskId: { in: [taskId, otherTask] } } }),
      0,
      'no refused call stored a code'
    );
  });

  test('preview handoff: mint → redeem from the bound origin is an 8 h non-refreshable session; single-use', async () => {
    const { taskId, origin } = await devCloudTask();
    const before = Date.now();
    const minted = await mint(taskId, bearer(userJwt(ctx.devUser)));
    assert.equal(minted.status, 201, JSON.stringify(minted.data));
    assert.equal(minted.headers.get('cache-control'), 'no-store');
    const code = String(minted.data.code);
    assert.match(code, /^[A-Za-z0-9_-]{43}$/, '256-bit base64url code');
    assert.equal(minted.data.preview_url, `${origin}/`, 'the task’s resolved preview URL');
    const ttl = Date.parse(String(minted.data.expires_at)) - before;
    assert.ok(ttl > 55_000 && ttl <= 61_000, `expires in ~60 s (${ttl} ms)`);

    const rows = await prisma.previewHandoffCode.findMany({ where: { taskId } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].codeHash, createHash('sha256').update(code).digest('hex'));
    assert.equal(rows[0].origin, origin, 'origin bound server-side');
    assert.equal(rows[0].userId, ctx.devUser);
    assert.ok(!JSON.stringify(rows[0]).includes(code), 'the plaintext code is never stored');

    const redeemed = await redeem(code, origin);
    assert.equal(redeemed.status, 200, JSON.stringify(redeemed.data));
    assert.equal(redeemed.headers.get('cache-control'), 'no-store');
    const access = jwt.verify(String(redeemed.data.access_token), signingEnv().secret, {
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
    const refresh = jwt.verify(String(redeemed.data.refresh_token), signingEnv().secret, {
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
    assert.equal(access.sub, ctx.devUser);
    assert.equal((access.amr as { method: string }[])[0].method, 'preview_handoff');
    assert.equal(access.act, undefined, 'the owner’s own identity, not an actor');
    assert.equal(access.app_metadata.preview_task_id, taskId);
    assert.equal(Number(access.exp) - Number(access.iat), EIGHT_HOURS, '8 h session');
    assert.equal(refresh.exp, access.exp, 'cannot be refreshed past the access token');
    assert.equal(redeemed.data.expires_at, access.exp);
    assert.equal((redeemed.data.user as { id: string }).id, ctx.devUser);
    assert.ok((await prisma.previewHandoffCode.findFirst({ where: { taskId } }))?.redeemedAt);

    const session = String(redeemed.data.access_token);
    const preview = await send(ctx.baseUrl, 'GET', `/api/claude-code-session/${taskId}/preview`, {
      headers: bearer(session),
    });
    assert.equal(preview.status, 200, `the preview session works: ${JSON.stringify(preview.data)}`);
    const again = await redeem(code, origin);
    assert.equal(again.status, 401, 'single-use');
    assert.equal(again.data.code, 'PREVIEW_HANDOFF_INVALID');
    const chained = await mint(taskId, bearer(session));
    assert.equal(chained.status, 403, JSON.stringify(chained.data));
    assert.equal(chained.data.code, 'USER_SESSION_REQUIRED', 'a preview session cannot re-mint');
  });

  test('preview handoff: a wrong or missing origin burns the code; an expired code is refused', async () => {
    const { taskId, origin } = await devCloudTask();
    const wrong = await mintCode(taskId);
    const evil = await redeem(wrong, 'https://5173-sbxattacker.e2b.app');
    assert.equal(evil.status, 403, JSON.stringify(evil.data));
    assert.equal(evil.data.code, 'PREVIEW_HANDOFF_ORIGIN_MISMATCH');
    const afterWrong = await redeem(wrong, origin);
    assert.equal(afterWrong.status, 401, 'the wrong-origin attempt burned it');
    assert.equal(afterWrong.data.code, 'PREVIEW_HANDOFF_INVALID');

    const originless = await mintCode(taskId);
    const missing = await redeem(originless);
    assert.equal(missing.status, 403, JSON.stringify(missing.data));
    assert.equal((await redeem(originless, origin)).status, 401);

    const stale = await mintCode(taskId);
    await prisma.previewHandoffCode.update({
      where: { codeHash: createHash('sha256').update(stale).digest('hex') },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const expired = await redeem(stale, origin);
    assert.equal(expired.status, 401, JSON.stringify(expired.data));
    assert.equal(expired.data.code, 'PREVIEW_HANDOFF_EXPIRED');
    assert.equal((await redeem(stale, origin)).data.code, 'PREVIEW_HANDOFF_INVALID');

    assert.equal((await redeem('short', origin)).status, 400);
    assert.equal((await redeem('a'.repeat(43), origin)).status, 401, 'unknown code');
  });

  test('preview handoff: no preview yet → 409; redeem CORS answers preview origins only', async () => {
    const agentId = await ctx.agentFor(ctx.devUser);
    const local = await ctx.codeSessionRow(ctx.devUser, agentId, {
      sandboxKind: 'local',
      homeDir: `/nonexistent/handoff-${randomUUID()}`,
    });
    const localTask = await ctx.taskRow(agentId, {
      sandboxId: 'local',
      streamUrl: 'ws://127.0.0.1:9',
      codeSessionId: local.id,
    });
    const notStarted = await mint(localTask, bearer(userJwt(ctx.devUser)));
    assert.equal(notStarted.status, 409, JSON.stringify(notStarted.data));
    assert.equal(notStarted.data.code, 'PREVIEW_UNAVAILABLE');

    const preflight = async (origin: string) => {
      const response = await fetch(`${ctx.baseUrl}/api/preview-handoff/redeem`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      });
      await response.arrayBuffer();
      return {
        status: response.status,
        allow: response.headers.get('access-control-allow-origin'),
      };
    };
    for (const origin of [
      'https://5173-abc123xyz.e2b.app',
      'https://5173-abc123xyz.e2b.dev',
      'http://localhost:5173',
      'http://127.0.0.1:41234',
    ]) {
      const answer = await preflight(origin);
      assert.equal(answer.status, 204, origin);
      assert.equal(answer.allow, origin, `preview origin allowed: ${origin}`);
    }
    for (const origin of [
      'https://evil.example',
      'https://5173-abc123xyz.e2b.app.evil.example',
      'https://www.roselabs.ai',
    ]) {
      assert.equal((await preflight(origin)).allow, null, `not a preview origin: ${origin}`);
    }
  });
}
