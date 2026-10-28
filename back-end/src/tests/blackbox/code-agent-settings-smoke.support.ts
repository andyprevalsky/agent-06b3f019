/**
 * Live-smoke helpers: the parent agent a smoke spawns its code agent from, and
 * the CLI settings that agent really runs (served model, effort, speed).
 *
 *   smokeParentAgent ──► Agent row { model, fastModeCacheEnabled } (Rose defaults:
 *                        Ultra, Fast Mode on; CODE_SMOKE_PARENT_MODEL /
 *                        CODE_SMOKE_FAST_MODE=0 pick another tier or Normal speed)
 *   session_capabilities (turn token) ──► effective_settings + catalog speeds
 *   assertSmokeSettings ──► model + effort from the tier table, speed = the
 *                           request mapped onto that catalog (Azure: priority)
 */
import {
  claudeCodeEffort,
  claudeCodeModel,
  codeAgentSpeed,
  codeAgentTier,
  codexAzureDeployment,
  codexCodeEffort,
  codexCodeModel,
} from '../../providers/codeAgentModels';
import { codeSessionTurnToken } from '../../providers/codeSessionTurns';
import { prisma } from '../../providers/database';

export interface SmokeParent {
  agentId: string;
  model: string;
  tier: 'ultra' | 'flash';
  speed: 'standard' | 'fast' | 'ultrafast';
}

export async function smokeParentAgent(userId: string): Promise<SmokeParent> {
  const model = (process.env.CODE_SMOKE_PARENT_MODEL ?? '').trim() || 'rose-labs/rose-1-ultra';
  const fastMode = process.env.CODE_SMOKE_FAST_MODE !== '0';
  await prisma.user.upsert({
    where: { userId },
    create: { userId, name: 'Code agent smoke' },
    update: {},
  });
  const agent = await prisma.agent.create({
    data: {
      userId,
      goal: 'code-agent live smoke parent',
      model,
      fastModeCacheEnabled: fastMode,
    },
    select: { id: true },
  });
  return { agentId: agent.id, model, tier: codeAgentTier(model), speed: codeAgentSpeed(fastMode) };
}

/** Soft-deletes the parent (its code-session rows keep their agent id). */
export async function deleteSmokeParent(parent: SmokeParent): Promise<void> {
  await prisma.agent.updateMany({
    where: { id: parent.agentId },
    data: { deletedAt: new Date() },
  });
}

interface Capabilities {
  effective_settings?: { model?: string; effort?: string | null; speed?: string };
  models?: { model: string; speeds?: string[] }[];
}

/** The live session's own answer to session_capabilities (needs the per-task turn token). */
export async function liveSessionSettings(wsUrl: string, taskId: string): Promise<Capabilities> {
  const WebSocket = (await import('ws')).default;
  return await new Promise<Capabilities>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('session_capabilities timed out'));
    }, 30_000);
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'session_capabilities', token: codeSessionTurnToken(taskId) }))
    );
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as Capabilities & { type?: string; status?: string };
      if (msg.type !== 'session_capabilities_ack') return;
      clearTimeout(timer);
      ws.close();
      if (msg.status !== 'delivered') reject(new Error(`capabilities ${JSON.stringify(msg)}`));
      else resolve(msg);
    });
    ws.on('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const CATALOG_TIERS: Record<string, string[]> = {
  ultrafast: ['ultrafast', 'fast', 'priority'],
  fast: ['priority', 'fast'],
};

/**
 * Asserts the served model, effort and speed and returns the proof line.
 * `azure` = the funded Azure provider, which offers priority only.
 */
export function assertSmokeSettings(
  provider: 'claude' | 'codex',
  parent: SmokeParent,
  caps: Capabilities,
  options: { azure?: boolean } = {}
): string {
  const settings = caps.effective_settings ?? {};
  const model =
    provider === 'claude'
      ? claudeCodeModel(parent.tier)
      : options.azure
        ? codexAzureDeployment(parent.tier)
        : codexCodeModel(parent.tier);
  const effort =
    provider === 'claude' ? claudeCodeEffort(parent.tier) : codexCodeEffort(parent.tier);
  const speeds = caps.models?.find((entry) => entry.model === settings.model)?.speeds ?? [];
  const requested = provider === 'claude' && parent.speed !== 'standard' ? 'fast' : parent.speed;
  const speed =
    provider === 'claude'
      ? requested === 'fast' && speeds.includes('fast')
        ? 'fast'
        : 'standard'
      : ((CATALOG_TIERS[requested] ?? []).find((tier) => speeds.includes(tier)) ?? 'standard');
  const line =
    `served model=${settings.model} effort=${settings.effort ?? 'default'} speed=${settings.speed}` +
    ` (parent ${parent.model} fast_mode=${parent.speed !== 'standard'}; catalog speeds ${speeds.join(',') || 'none'})`;
  const want = {
    model,
    effort,
    speed: options.azure && parent.speed !== 'standard' ? 'priority' : speed,
  };
  const got = { model: settings.model, effort: settings.effort, speed: settings.speed };
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(
      `code-agent settings ${JSON.stringify(got)} != ${JSON.stringify(want)}: ${line}`
    );
  }
  return line;
}
