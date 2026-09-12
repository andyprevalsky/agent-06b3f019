# Independently owned immutable fleet sources

`scripts/run-bench-fleet` normally uses the shared `cloudbench-warm` source. Its
stopped-source guard remains mandatory. If another owner is using that source,
an independently prepared source can be selected without changing shared state:

```bash
CLOUDBENCH_SOURCE_MANIFEST=/absolute/path/source-manifest.json \
  bash scripts/run-bench-fleet <bench> [<bench>...] [existing flags]
```

Preparation and retirement belong to the source's owner, outside fleet teardown.
The fleet never creates, refreshes, starts, parks, updates, or deletes this base.
It only validates it and clones its completed snapshot. Do not prepare a source
by stopping or modifying another owner's machine. Retain the source until every
fleet that references it has completed exact resource cleanup.

The version-one manifest has exactly these fields:

```json
{
  "version": 1,
  "app": "navi-whisper-lux-bench",
  "owner_token": "<32 lowercase hexadecimal characters>",
  "machine_id": "<exact machine ID>",
  "instance_id": "<native instance ID after final configuration>",
  "machine_name": "cloudbench-source-<full owner token>",
  "volume_id": "<exact vol_ ID>",
  "region": "iad",
  "image_digest": "sha256:<64 lowercase hexadecimal characters>",
  "snapshot_id": "<exact vs_ ID>",
  "node_fingerprint": "<current Node manifest fingerprint>",
  "python_fingerprint": "<current Python manifest fingerprint>",
  "verified_at": 1789116920,
  "shared_machine_id": "<protected shared warm machine ID>",
  "shared_volume_id": "<protected shared warm volume ID>"
}
```

The placeholders are documentation, not valid identities. `verified_at` is the
actual Unix epoch of dependency verification. Obtain fingerprints using the
existing helpers in `scripts/lib/cloudbench-env.sh`; verify the installed Node
and Python fingerprint markers inside the owned source before taking its snapshot.
The existing task-guest installed-dependency check still runs on every clone.

The source must be stopped and already parked at shared CPU, one CPU, and the
configured parked memory (default 2048 MiB). Its only mount is the named volume at
`/data`. The volume must be created, attached to that exact machine, and in the
same region. The provider's native instance, pinned image digest, machine name,
and `config.metadata.cloudbench_source_owner` must match the manifest. The
snapshot must be complete, belong to that exact mounted volume's snapshot list,
and pass the existing snapshot selector's completeness rule. It cannot predate
dependency verification beyond the existing 60-second timestamp allowance.

The fleet captures one immutable canonical copy before allocation. The same
captured bytes determine the selected identities, pool namespace, registry/audit
proof, and execution provenance. A changed caller file cannot retarget a running
fleet. Native instance, stopped state, and storage readiness are checked again
at clone admission through the existing refreshed inventory index.

Private mode rejects stale dependency fingerprints and never invokes shared
dependency maintenance. It rejects either protected machine or volume in pool
claims and cleanup mutations. Default shared mode remains unchanged. Exact stale
owner recovery restores the private/shared protections from matching, digest-bound
registry and audit copies even when the original environment variable is absent.
A missing or changed required manifest fails closed and retains ownership.

See the [source-selection RCA](rca/cases/2026-09-12-fleet-required-active-shared-source-without-owned-alternative.md)
for the causal offline proof and remaining live validation gate.
