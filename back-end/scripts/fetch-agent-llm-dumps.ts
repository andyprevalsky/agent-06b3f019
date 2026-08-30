import fs from 'node:fs';
import path from 'node:path';
import {
  decryptAndValidateArtifact,
  listArchivedObjects,
  readArchivedArtifact,
} from '../src/providers/traceArchive';

async function main() {
  const agentId = process.argv[2];
  if (!agentId) {
    throw new Error('usage: npx tsx scripts/fetch-agent-llm-dumps.ts <agent_id>');
  }
  const objs = await listArchivedObjects(agentId);
  console.error(`listed ${objs.length} object(s) for ${agentId}`);
  for (const o of objs) {
    console.error(`  ${o.path}`);
  }
  const llmObjs = objs.filter((o) => o.path.startsWith('llm/') && o.path.endsWith('.json.gz.enc'));
  const outDir = path.resolve('/workspace/.llm-dumps', agentId);
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
    const ts = dump.ts_ms || dump.ingested_ms || Date.now();
    const dumpId = String(dump.dump_id || dump.span_id || path.basename(obj.path, '.json.gz.enc'));
    const callSite = String(dump.call_site || 'unspecified').replace(/[^a-zA-Z0-9._-]/g, '_');
    const file = path.join(outDir, `${ts}-${dumpId.slice(0, 64)}-${callSite}.json`);
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
