export type WorkerRuntimeQuery = Record<string, unknown>;
export type WorkerRuntimeEnvelope = Record<string, unknown>;
export type WorkerRuntimeIssuer = (query: WorkerRuntimeQuery) => Promise<WorkerRuntimeEnvelope>;
