PR #2293 browser-chip recovery closeout

The repair merged as `1ac75606167f7973aeb63f983eedfa8aed2c3775`. The original
semantic command passed all 76 native cases on final integrated source, including
both browser-chip cases, without a native flake; cleanup completed. The assigned
marker is released, with original assertions and the 30-second budget unchanged.
Render, Vercel, endpoint probes/log scan, native Mac release and production
semantics verified that exact merge. Production semantic evidence:
https://github.com/Rose-Ai-Labs/rose/actions/runs/43838938423 .

Two additional backend flakes were attributed NOT_INTRODUCED on unchanged
backend trees and delivered after merge to the repair threads in
`postmerge-handoffs.json`. The marker edits in this records PR only replace
pending repair links; all guards, assertions and test behavior remain unchanged.
The iPhone owner already owns the same single-sample-outlier cause.

Private evidence receipts use the existing bounded AES-GCM archive helper
`docs/handoffs/whm-b07d9037-preservation/private_archive.py`. Restore with
`agents/venv/bin/python <helper> restore --receipt <receipt.json> --destination
<new-empty-directory>`, using authoritative project-managed encryption settings.
Never print keys or overwrite a live checkout, database or protected configuration.
Every receipt records authenticated full-object read-back and member hashes.
Archive members retain HOME-relative paths. The final capture inventory maps
original paths to immutable copies, including private configuration.

The four native smoke packets preserve every actual source, original task
verdict, allocation and teardown receipt. Task-free canaries receive no smoke
credit. Final source smoke: 7 PASS, 0 FAIL/SKIP/unexecuted; 9 original machine/volume
pairs released, controllers/Hubs/relay/inventory absent. Older failed attempts
and interrupted receipts remain private evidence and grant no new-source PASS.

The 602 inherited local branches are preserved in the self-contained Git bundle
described by `docs/handoffs/browser-chip-count-repair/inherited-branches.json`
and exact-tip bindings in this closeout manifest. No branches were deleted.
Freedom, protected instructions, foreign resources and designated warm resources
were not changed. This follow-up publishes records, not another service rollout.

CodeRabbit spending-cap review SKIPPED: primary PR merged unreviewed. Anthropic
credential-health retained its HTTP 400 credits-exhausted warning. Mac-only
pre-merge checks were omitted on Linux, never claimed PASS; production Mac release
ran on its native macOS runner. Current full-sweep quarantine report:
Tests skipped (quarantined): 11 — 0 failed (non-blocking), 11 passed
Flaky (passed on rerun): 2 — 2 attributed, 0 awaiting /RCA attribution (blocks merge)
The two flakes are the earlier attributed occurrences, not final-sweep reruns.

Factory execution snapshot: Codex gpt-6.1-sol/high via boxes-managed-openai,
actual parent harness 0.166.0. Parent service tier and deploy-scoped token/cost
usage are UNMEASURED because the original scope lacks a counter baseline.
Timeline gaps remain unrecorded waits rather than invented active work.

Final private capture: 164,086 files / 6,263,158,292 uncompressed bytes,
1,669,500,436 encrypted bytes. Authenticated full read-back verified every
archive member; see `private-archive-receipt.json` and `capture-summary.json`.
