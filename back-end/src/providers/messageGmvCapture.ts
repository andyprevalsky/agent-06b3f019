/**
 * Harvest platform GMV from TOOL FINISHED messages that carry structured_response.
 * Uses a dynamic import of the purchases domain so providers stay statically
 * domain-agnostic for the layer-deps boundary.
 */

import { prisma } from './database';
import { createLogger } from './logger';

const log = createLogger('MessageGmvCapture');

export interface MessageGmvCaptureInput {
  agentId: string;
  role: string;
  metadata?: Record<string, unknown> | null;
}

function stringMetadataValue(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function structuredResponseFromMetadata(
  metadata: Record<string, unknown> | null | undefined
): unknown {
  if (metadata === null || metadata === undefined) return null;
  const structured = metadata.structured_response ?? metadata.structuredResponse;
  return structured === undefined ? null : structured;
}

export async function maybeCaptureMessageGmv(params: MessageGmvCaptureInput): Promise<void> {
  if (params.role !== 'TOOL') return;
  const metadata = params.metadata;
  if (metadata === null || metadata === undefined) return;
  const toolStatus = stringMetadataValue(metadata, 'toolStatus');
  if (toolStatus !== 'FINISHED') return;
  const structured = structuredResponseFromMetadata(metadata);
  if (structured === null) return;

  const { maybeRecordStructuredGmv } = await import('../domains/purchases/structuredGmv');
  const agent = await prisma.agent.findUnique({
    where: { id: params.agentId },
    select: { userId: true },
  });
  if (agent === null) return;
  const toolName = stringMetadataValue(metadata, 'toolName') ?? 'tool';
  await maybeRecordStructuredGmv({
    userId: agent.userId,
    agentId: params.agentId,
    structured,
    source: `message.${toolName}.structured_response`,
  });
}

export function scheduleMessageGmvCapture(params: MessageGmvCaptureInput): void {
  void maybeCaptureMessageGmv(params).catch((error: unknown) =>
    log.warn('Structured GMV message capture failed', {
      agentId: params.agentId,
      error: error instanceof Error ? error.message : String(error),
    })
  );
}
