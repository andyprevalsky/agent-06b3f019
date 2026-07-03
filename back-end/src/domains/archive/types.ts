import type { EncryptedArtifactMetadata } from '../../providers/traceArchive';

export interface StoreEncryptedArtifactRequest {
  rootAgentId: string;
  path: string;
  ciphertextB64: string;
  metadata: EncryptedArtifactMetadata;
}

export interface AgentStartRequest {
  agentId: string;
}

export interface AgentFinalizeRequest {
  rootAgentId: string;
  benchmarkTaskName?: string;
  force?: boolean;
}

export interface ArchiveArtifactRef {
  ref: string;
  metadata?: EncryptedArtifactMetadata;
}
