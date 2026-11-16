# PR2403 private preservation recovery

These safe receipts identify encrypted private carriers. They contain no credentials or raw provider/production evidence. Use the existing authoritative project configuration and unchanged helper `docs/handoffs/whm-b07d9037-preservation/private_archive.py` (SHA256 `2e35e736660660bb6118a939d51b0dd008abe5efaa6387cf252d5d0536b75cf4`). Do not shell-source dotenv files or rotate the established encryption key. Python dependencies are available in `agents/venv`.

For each receipt, run from the repository root:

```bash
PYTHONDONTWRITEBYTECODE=1 agents/venv/bin/python -B docs/handoffs/whm-b07d9037-preservation/private_archive.py verify --receipt /absolute/path/to/receipt.json
PYTHONDONTWRITEBYTECODE=1 agents/venv/bin/python -B docs/handoffs/whm-b07d9037-preservation/private_archive.py restore --receipt /absolute/path/to/receipt.json --destination /absolute/path/to/new-empty-private-directory
```

Use a distinct, new empty destination for each carrier. Never overlay active source, configuration, database or process state. The primary archive contains staged source records, actual ignored configuration and the private original-path/hash/size/mode/namespace manifest. Recover regular files by that mapping. The symlink is recorded separately as metadata and its target files are included; deliberately recreate it only after checking its destination. The gate carrier supplies the excluded gate-attribution subtree; its two dependency symlinks are recorded exclusions. The inherited Git carrier supplies a self-contained all-ref bundle captured before deployment; do not restore its old active feature-branch tip over current refs. The supplemental carrier supplies private inventory/process/guard metadata, scripts and receipts; generated staging and restored copies are recoverable from the carriers rather than separately uploaded.

All four carriers received native full authenticated readback and separate full verification. The primary and supplemental carriers also received complete independent restores with content hashes checked. Exact inherited 72 branch tips plus one stash were rechecked without fetching. Native deletion readiness is not claimed: the parent owns final manifest review, records-only follow-up PR, any later records, source/ref changes and `scripts/deploy deletion-check`.

Commit these safe public files and the final handoff in the reviewed records-only closeout PR. Public files created after supplemental capture are preserved by that PR, not claimed inside their own archive. Preserve Freedom and protected instructions; no cleanup or process termination is authorized by this recovery recipe.
