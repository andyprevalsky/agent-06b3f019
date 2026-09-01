export interface AgentQueuePointerPayload {
  taskQueue: string;
  surfaceHash: string | null;
  updatedBy: string | null;
  updatedAt: Date | null;
}
