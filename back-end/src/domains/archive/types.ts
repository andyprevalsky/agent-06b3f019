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
  benchmarkPassed?: boolean;
  benchmarkStatus?: string;
  failureReason?: string | null;
  /** World-model execution mode of the run (real | shadow | simulate). Defaults to real. */
  worldModelMode?: string;
  force?: boolean;
}

export interface ArchiveArtifactRef {
  ref: string;
  metadata?: EncryptedArtifactMetadata;
}
