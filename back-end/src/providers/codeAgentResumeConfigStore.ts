import {
  codeResumeConfigMessage,
  spawnToolCallId,
  type CodeResumeConfigInput,
} from './codeAgentResumeConfig';
import { createMessageOnce } from './messages';
import { prisma } from './database';
import { codeCliSettingsSchema } from './codeCliSettings';
import type { CodeCliSettingsOverride } from './codeAgentModels';
import { Prisma } from '@prisma/client';

/** Message PK idempotency makes the first per-task snapshot immutable, without a TTL. */
export async function persistCodeResumeConfig(input: CodeResumeConfigInput): Promise<void> {
  const message = codeResumeConfigMessage(input);
  if (message !== null) await createMessageOnce(message);
}

/** A new run of the same spawn keeps its saved CLI settings; explicit turn keys win. */
export async function resumeLaunchCliSettings(
  agentId: string,
  provider: 'claude' | 'codex',
  leaseOwner: string | null | undefined,
  overrides: CodeCliSettingsOverride | null | undefined
): Promise<CodeCliSettingsOverride | undefined> {
  const toolCallId = spawnToolCallId(agentId, leaseOwner);
  if (toolCallId === null) return overrides ?? undefined;
  const row = await prisma.message.findFirst({
    where: {
      agentId,
      role: 'TOOL',
      AND: [
        { metadata: { path: ['action_type'], equals: 'code_resume_config' } },
        { metadata: { path: ['toolCallId'], equals: toolCallId } },
        { metadata: { path: ['codeAgentResumeConfig', 'code_provider'], equals: provider } },
      ],
    },
    orderBy: { timestamp: 'desc' },
    select: { metadata: true, timestamp: true },
  });
  // Only observed, complete receipts qualify. Queued turns and requested partial
  // settings never establish what the live CLI actually applied.
  const receipt = await prisma.message.findFirst({
    where: {
      agentId,
      role: 'TOOL',
      AND: [
        { metadata: { path: ['action_type'], equals: 'user_direct_turn' } },
        { metadata: { path: ['toolCallId'], equals: toolCallId } },
        { metadata: { path: ['code_provider'], equals: provider } },
        ...['model', 'effort', 'speed'].map((key) => ({
          metadata: { path: ['effective_settings', key], not: Prisma.AnyNull },
        })),
      ],
    },
    orderBy: { timestamp: 'desc' },
    select: { metadata: true, timestamp: true },
  });
  if (receipt !== null && (row === null || receipt.timestamp > row.timestamp)) {
    const metadata = receipt.metadata as Record<string, unknown>;
    const effective = metadata.effective_settings as Record<string, unknown>;
    const saved = codeCliSettingsSchema.required().parse({
      model: effective.model,
      reasoning_effort: effective.effort,
      speed: effective.speed,
    });
    return {
      ...saved,
      ...Object.fromEntries(
        Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined)
      ),
    };
  }
  if (row === null) return overrides ?? undefined;
  const metadata = savedResumeConfig(row.metadata);
  if (metadata.version !== 1)
    throw new Error('Saved code resume configuration version is unsupported');
  const saved = codeCliSettingsSchema.required().parse(metadata.cli_settings);
  const explicit = Object.fromEntries(
    Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined)
  );
  return { ...saved, ...explicit };
}

function savedResumeConfig(metadata: unknown): Record<string, unknown> {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Saved code resume configuration is invalid');
  }
  const config = (metadata as Record<string, unknown>).codeAgentResumeConfig;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Saved code resume configuration is invalid');
  }
  return config as Record<string, unknown>;
}
