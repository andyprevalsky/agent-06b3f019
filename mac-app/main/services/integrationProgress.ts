/**
 * Service shim for the integration-progress domain
 * (`main/domains/integration-progress/`). Call sites and blackbox test mocks
 * import `IntegrationProgress` from here, mirroring the other
 * `main/services/*` shims.
 */
export { IntegrationProgress } from '../domains/integration-progress/runtime';
export type {
  ProgressPostResult,
  ProgressRun,
  ProgressRunWrite,
  ProgressWriteBody,
} from '../domains/integration-progress/runtime';
