export interface AgentQueuePointerPayload {
  managedDeploymentProtocol: 1;
  managedQueue: boolean;
  continuationAdmitted: boolean;
  taskQueue: string;
  surfaceHash: string | null;
  updatedBy: string | null;
  updatedAt: Date | null;
}
