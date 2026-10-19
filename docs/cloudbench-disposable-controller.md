# Disposable large controller

The explicit `run-cloudbench-controller-gate --disposable-controller AUTHORITY -- COMMAND`
route creates one performance-8x / 32768 MiB controller and a 256 GiB workspace.
The ordinary unadmitted gate route still refuses creation. The benchmark's own
200-task, three-repeat, 600-concurrency, 1200/5400-second arguments and required
N2 checks are independent of the host's bootstrap/export watchdog.

The root-owned caller supplies a private `cloudbench-disposable-controller-authority-v1`
file binding the current source commit, a measured organization capacity proof,
exact output directory, live cleanup-owner PID and birth, protected Machine and
Volume IDs, and hashes of the current complete agents/backend environment files.
The files override inherited app environment only on the new controller; this
operation does not update app secrets. Creation authority expires after 300 seconds.
An already allocated host can export and clean up after that interval without
resetting the original benchmark clock.

The gate seals the exact Machine, workspace and pinned image, disables scheduled
workspace backups before Machine creation, and exports originals using the
existing checked controller exporter. It retains the host until the caller has
joined the actual remote supervisor and verified the export. The caller must
stay alive through cancellation, signal only the positively identified supervisor,
and wait for its canonical child cleanup. A gate timeout is pending closure, not
permission to destroy a still-running benchmark.

After a verified export, the caller invokes `cloudbench-disposable-controller.py cleanup`
with the original authority, root, directory and workspace-ownership paths.
It issues at most one DELETE for the exact Machine, confirms destruction, then
issues at most one DELETE for the detached workspace Volume. Existing intents
permit GET-only reconciliation. Volume `pending_destroy` is reported as soft
deleted, not falsely reported absent. Failure to establish identity, export,
detachment, or terminal state leaves a pending operation and its original receipts.

If Machine creation failed and a complete current inventory proves no Machine
with the original intended name or workspace mount exists, `cleanup-workspace`
can dispose of the exact detached, owned workspace without inventing an export
or claiming that no command ever ran historically.
An ambiguous Machine allocation requires identity recovery and normal export
closure. Warm/base/WHM and separately owned resources remain excluded.
