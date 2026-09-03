import fs from 'node:fs';
import path from 'node:path';
import {
  decryptAndValidateArtifact,
  listArchivedObjects,
  readArchivedArtifact,
} from '../src/providers/traceArchive';

const LLM_DUMPS_ROOT = path.resolve('/workspace/.llm-dumps');

function sanitizePathComponent(value: string, maxLength = 128): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_');
  return sanitized.slice(0, maxLength) || 'unknown';
}

function assertSafeAgentId(agentId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(agentId)) {
    throw new Error(
      `invalid agent_id ${JSON.stringify(agentId)}: expected a short alphanumeric id`
    );
  }
  return agentId;
}

function assertPathInsideRoot(candidate: string, root: string): string {
  const resolved = path.resolve(candidate);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error(`refusing to write outside ${root}: ${resolved}`);
  }
  return resolved;
}

async function main() {
  if (!process.argv[2]) {
    throw new Error('usage: npx tsx scripts/fetch-agent-llm-dumps.ts <agent_id>');
  }
  const agentId = assertSafeAgentId(process.argv[2]);
  const objs = await listArchivedObjects(agentId, { throwOnError: true });
  console.error(`listed ${objs.length} object(s) for ${agentId}`);
  for (const o of objs) {
    console.error(`  ${o.path}`);
  }
  const llmObjs = objs.filter((o) => o.path.startsWith('llm/') && o.path.endsWith('.json.gz.enc'));
  const outDir = assertPathInsideRoot(path.join(LLM_DUMPS_ROOT, agentId), LLM_DUMPS_ROOT);
  fs.mkdirSync(outDir, { recursive: true });
  let written = 0;
  for (const obj of llmObjs) {
    const stored = await readArchivedArtifact({ rootAgentId: agentId, objectPath: obj.path });
    if (!stored) {
      console.error(`missing ${obj.path}`);
      continue;
    }
    const plain = decryptAndValidateArtifact(stored);
    const payload = JSON.parse(plain.toString('utf8'));
    const dump = payload?.kind === 'legacy-llm-dump' && payload.payload ? payload.payload : payload;
    const ts = sanitizePathComponent(String(dump.ts_ms || dump.ingested_ms || Date.now()), 32);
    const dumpId = sanitizePathComponent(
      String(dump.dump_id || dump.span_id || path.basename(obj.path, '.json.gz.enc')),
      64
    );
    const callSite = sanitizePathComponent(String(dump.call_site || 'unspecified'), 64);
    const file = assertPathInsideRoot(
      path.join(outDir, `${ts}-${dumpId}-${callSite}.json`),
      outDir
    );
    fs.writeFileSync(file, JSON.stringify(dump, null, 2));
    console.error(`wrote ${path.basename(file)} call_site=${dump.call_site}`);
    written += 1;
  }
  console.error(`wrote ${written} dump(s) to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
