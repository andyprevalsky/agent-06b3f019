import { runBrowserProviderLifecycleCases } from './browser-session-provider-lifecycle.cases';

/**
 * Provider-lifecycle section of the browser-session domain. It was quarantined after FLAKY
 * occurrence 2d9047dbcd51485cbefa5d3d6dae614a (PR #1928, NOT_INTRODUCED): a lifecycle fixture
 * worker failed before ready when the coverage Postgres refused connections. The marker was
 * released on 2026-11-13 (PR #2014) after five consecutive passes; the section now blocks again.
 */
export const runQuarantinedProviderLifecycleCases = runBrowserProviderLifecycleCases;
