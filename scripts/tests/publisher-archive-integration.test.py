"""Offline integration of the Python publisher and actual encrypted archive CLI."""

import hashlib
import importlib.util
import json
import os
import subprocess
import tempfile
import uuid
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
root_id = str(uuid.uuid4())
spec = importlib.util.spec_from_file_location(
    "publisher", repo / "scripts/publish_evidence_links.py"
)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
with tempfile.TemporaryDirectory(prefix="publisher-archive-integration-") as temporary:
    folder = Path(temporary)
    network_guard = folder / "forbid-network.cjs"
    network_guard.write_text(
        "require('node:net').Socket.prototype.connect = function () { throw new Error('Archive fixture attempted network'); }; "
        "global.fetch = () => { throw new Error('Archive fixture attempted fetch'); };\n"
    )
    os.environ.update(
        {
            "TRACE_ARCHIVE_BACKEND": "local",
            "TRACE_ARCHIVE_ENABLED": "1",
            "TRACE_ARCHIVE_LOCAL_DIR": str(folder / "archive"),
            "TRACE_ARCHIVE_ENCRYPTION_KEY_B64": "FxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxc=",
            "NODE_ENV": "test",
            "ENVIRONMENT": "test",
            "NODE_OPTIONS": f"--require={network_guard}",
        }
    )
    fixture = folder / "fixture.ts"
    module = (repo / "back-end/src/providers/traceArchive.ts").as_posix()
    fixture.write_text(
        """import fs from 'node:fs';
import path from 'node:path';
import { encryptArtifact } from MODULE;
const root = ROOT;
const base = { root_agent_id: root, agent_id: root, dump_id: 'first', span_id: 'original-span', messages: [{role: 'user', content: 'local fixture'}], config: {keep: 1} };
for (const [name, payload, time] of [
  ['llm/first.json.gz.enc', base, 100],
  ['llm-updates/first-update.json.gz.enc', {root_agent_id: root, agent_id: root, dump_id: 'first', span_id: 'later-context-span', output: 'actual response fixture', config: {added: 2}}, 200],
] as const) {
  const stored = encryptArtifact(name, Buffer.from(JSON.stringify(payload)), 'application/json');
  if (!stored) throw new Error('fixture encryption failed');
  stored.metadata.created_at_ms = time;
  const target = path.join(process.env.TRACE_ARCHIVE_LOCAL_DIR!, 'trace-archive', root, name);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, stored.ciphertext);
  fs.writeFileSync(target + '.meta.json', JSON.stringify(stored.metadata));
}
""".replace("MODULE", json.dumps(module)).replace("ROOT", json.dumps(root_id))
    )
    subprocess.run(
        ["node", "--import", "tsx", str(fixture)],
        cwd=repo / "back-end",
        check=True,
        timeout=30,
    )
    publisher.ARTIFACTS_ROOT = folder / "evidence"
    publisher._load_cli_environment()
    recovered = publisher.latest_dump_for_agent(root_id)
    payload = json.loads(recovered.read_text())
    assert payload["span_id"] == "original-span"
    assert payload["output"] == "actual response fixture"
    assert payload["config"] == {"keep": 1, "added": 2}
    assert recovered.is_relative_to(publisher.ARTIFACTS_ROOT)
    assert recovered.name.startswith("100-"), "recorded base chronology is preserved"
    print(
        json.dumps(
            {
                "result": "PASS",
                "pathVerified": True,
                "sha256": hashlib.sha256(recovered.read_bytes()).hexdigest(),
                "networkCalls": 0,
            }
        )
    )
