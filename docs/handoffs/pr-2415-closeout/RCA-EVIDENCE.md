# PR #2415 RCA evidence

The original required smoke failure, rejected experiments, exact pack/index,
and controlled CPU replay are preserved independently of either devbox in the
private AES-GCM archive named by `rca-archive-receipt.json`. Its upload verified
all 125 original files by a complete authenticated readback. The source repair
and full deployment are separate obligations; this receipt grants no smoke,
production or cleanup PASS.

Restore with the existing `docs/handoffs/whm-b07d9037-preservation/private_archive.py`
tool, the receipt, and an empty private destination. Paths inside the archive
are home-relative. The exact replay pack/index is under
`code-session-repair-evidence/phase1/same-pack-replay/`; the original packet is
under `code-session-repair-evidence/phase1/original-packet/`. Relocate embedded
originating-box paths instead of assuming that box remains available.

The local pack comparison runs `git index-pack --verify` on that immutable pack
with `core.deltaBaseCacheLimit` set to 96m, 512m, 512m, 96m. The archived Python
runner records child CPU and wall time separately; point its pack selection at
the restored pack directory. All four recorded commands exited0. This is a
long CPU replay: run it under an owned background session and watch it through
exit, without changing the pack or assertions. It uses no model, provider or
production database.

Final source validation, unchanged cloud smoke, production verification and
closeout receipts are recorded by this workspace's normal deploy pipeline.
