import path from 'node:path';
import { config } from 'dotenv';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    process.stdout.write(
      'Usage: fetch-agent-llm-dumps.ts ROOT_AGENT_ID [--output-dir ABS] [--json]; backend defaults to r2, explicit TRACE_ARCHIVE_BACKEND wins'
    );
    return;
  }
  const rootAgentId = argv.shift();
  if (!rootAgentId) throw new Error('ROOT_AGENT_ID is required; use --help');
  let outputDir = '/workspace/.llm-dumps';
  let machineReadable = false;
  while (argv.length) {
    const flag = argv.shift();
    if (flag === '--json') machineReadable = true;
    else if (flag === '--output-dir') {
      const value = argv.shift();
      if (!value || !path.isAbsolute(value))
        throw new Error('--output-dir requires an absolute path');
      outputDir = value;
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  // Resolve independently of caller cwd and preserve explicitly supplied environment.
  config({ path: path.resolve(__dirname, '../.env'), override: false, quiet: true });
  const { materializeArchiveLlmDumps, archiveRecoveryBackend } =
    await import('../src/providers/archiveLlmMaterialization');
  process.env.TRACE_ARCHIVE_BACKEND = archiveRecoveryBackend(process.env.TRACE_ARCHIVE_BACKEND);
  const { listArchivedObjectsStrict, readArchivedArtifactStrict } =
    await import('../src/providers/traceArchive');
  const result = await materializeArchiveLlmDumps(rootAgentId, outputDir, {
    list: listArchivedObjectsStrict,
    read: (root, objectPath) => readArchivedArtifactStrict({ rootAgentId: root, objectPath }),
  });
  if (machineReadable) {
    const {
      rootAgentId,
      manifestPath,
      manifestSha256,
      latest,
      baseCallCount,
      updateCount,
      agentIds,
    } = result;
    process.stdout.write(
      `${JSON.stringify({ rootAgentId, manifestPath, manifestSha256, latest, baseCallCount, updateCount, agentIds })}\n`
    );
  } else
    process.stderr.write(
      `Verified ${result.baseCallCount} calls + ${result.updateCount} updates; manifest: ${result.manifestPath}; latest: ${result.latest.path}`
    );
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.message : 'Archive recovery failed');
  process.exitCode = 1;
});
