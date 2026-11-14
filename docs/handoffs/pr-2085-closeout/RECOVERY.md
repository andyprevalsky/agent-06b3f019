# Private workspace recovery

The [catalog](archive-catalog.json) contains only nonsecret immutable object
keys, receipt hashes and verification scopes. Private paths, provider payloads,
configuration, original failures, traces and complete ref maps remain encrypted.
No workspace, branch, browser row, payment or provider resource is deleted by
this closeout. Preserve Freedom and protected instructions/services.

Use a clean checkout containing the pinned helper in the catalog. Obtain the
**existing** trace-archive R2 configuration and original encryption-key version
through authorized Rose/Navi Render access. Use the canonical paginated reader
`back-end/scripts/render-env.ts`; do not print or commit returned secrets.
Present external availability was verified independently of local env files.
There is no claim of independent escrow or guaranteed future key retention.
Rose project maintainers must retain authorized bootstrap access and the named
key version. Never generate a replacement key for an old encrypted object.

The pinned helper requires the absolute paths `/home/boxes/rose/agents/.env` and
`/home/boxes/rose/back-end/.env` even when invoked from another checkout. It reads
them in that order, last nonempty value wins;
injected environment values do not substitute for these files. Provision the
necessary configuration privately at those exact paths on an isolated recovery
host (or a matching isolated filesystem layout). Do not replace an existing
live checkout or protected configuration to create that layout. Reconstruct a receipt
JSON from the exact `receipt` member of the catalog, keeping its original bucket
and object key. Each key is authenticated AAD, so renaming/copying the encrypted
object under another key changes the decryption contract.

From the clean repository, with existing dependencies available:

```bash
agents/venv/bin/python docs/handoffs/whm-b07d9037-preservation/private_archive.py verify --receipt /private/receipt.json
agents/venv/bin/python docs/handoffs/whm-b07d9037-preservation/private_archive.py restore --receipt /private/receipt.json --destination /private/new-empty-directory
```

Use a different new, empty, private destination for every object. Recheck the
restored authenticated manifest against every file hash. Restore is regular-file
only; the final supplement's private recovery map assigns each logical path its
exact mode and byte carrier, including deduplicated bytes in earlier objects or
pinned Git blobs. Reconstruct links and directory metadata selectively in an
isolated recovery copy; never follow arbitrary links, overwrite a live checkout,
restore platform identities, weaken protected instructions or replay operational
scripts. Ownership, ACLs and xattrs are not automatically reconstructed.

The all-ref bundle preserves local-only source/history. Its local independent
bare-mirror restore and full fsck verified19532 refs before upload; the uploaded
object then passed full authenticated readback. Recover it into a separate bare
repository and verify its private ref inventory. Newer application/records
commits are separately pinned to verified advertised Git remotes. Do not claim
that a clean working tree alone preserves unpublished history.

The old-cycle object preserves original FAILED/UNVERIFIED outcomes and stale
source bindings. Internal historical absolute paths are intentionally unchanged;
use the private relocation map. No old gate credit transfers to the final cycle.
The first RCA selection accidentally omitted one generated252-byte baseline log
as source; the final supplement corrects that omission with an exact byte carrier.
The four unique rendered-evidence files are also covered; duplicates have
hash-and-size carrier mappings rather than speculative cache exclusions.

Verification scope is object-specific in the catalog. In particular, the old
cycle has full authenticated readback, not an actual empty-directory full-restore
claim. A receipt proves preserved bytes, never a passing test, financial
settlement, provider cleanup or permission to delete this machine.

The committed deletion manifest contains only the exact nonsecret branch
locators needed by the unchanged native checker for local-only history, plus
the stash commit locator. It omits530 unnecessary branch entries. The complete
19532-ref inventory, config paths and recovery carrier map stay encrypted.
These minimal locators are recovery/check metadata, not private trace payloads
or permission to delete refs.
