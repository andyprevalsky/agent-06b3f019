# Recovery

Use a separate private checkout of the commit containing this directory.
The encrypted object references and authenticated receipt sidecars are in
archive-index.json. The manifest binds all current local-only refs and ignored
path dispositions. Historical source bundles retain their original PR1634
authenticated identity proof; see docs/handoffs/pr-1634-closeout/RECOVERY.md.

Managed project configuration delivers .context/pr1634-archive-recovery.env
with the recovery value; agents/.env and back-end/.env provide R2 access.
Never print or commit those values. The key fingerprint must equal the one
in archive-index.json.

Use the pinned existing adapter to fetch each encrypted receipt sidecar, then
restore that receipt into a new empty private directory. It checks authenticated
framing, safe paths, member hashes and complete readback. Commands and required
dependencies are in docs/handoffs/pr-1634-closeout/README.md. Do not overwrite a
live environment or restore old machine identity tokens.

Archives capture finite on-disk state and transactionally consistent private
SQLite backups; they do not claim whole-browser atomicity or process-memory
resumption. Raw DB/WAL families are also preserved. Final changing log prefixes
and supplemental task records are explicitly indexed. The committed closeout
metadata and native readiness receipt are durable in Git after their records
PR merges; they are not recursively archived into themselves.
