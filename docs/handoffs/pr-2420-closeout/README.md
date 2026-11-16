# PR #2420 closeout

The iframe regression stability repair merged as `1ec28940191764ecf435ffc38b345006269bc95b` from reviewed/gated source `30558b794e25845d77a1b2b8537ea146d491c948`. Original `af040751e3` authorship is retained via cherry-pick `7a059f9c97`. PR #2352 was closed as superseded with the replacement link.

The test now waits for pointer delivery to the exact OOPIF target before clicking. All original assertions, fixture geometry and deadlines remain; runtime coordinate translation was already shipped. The assigned quarantine occurrence `0e5f6905bb444c74ba092235d99fcfb1` is removed after direct cause verification.

## Validation

- Original command: `cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py spawn-browser-agent-v3`; PASS, 1 domain / 0 failed, 277.0 seconds, native exit 0.
- Identical deterministic GPU-stall harness: baseline 8/8 failures (native exit 1), final source 8/8 passes (native exit 0). Logs and source hashes are in the private archive and `validation-proof.json`.
- Loaded final-source proof: 36/36 passes with 12 parallel copies and 12 busy loops; coordinate negative control fails at `(115, 136)`.
- Independent fresh read-only reviewer `ph72qwawtvxm98hjf0kab117b98ja8fy`: APPROVE; full report in `fresh-review.md`. It confirms all seven original assertions and the test registration. The polling deadline is not hard cancellation of awaited CDP operations; finite repeats cannot establish universal flake freedom.
- Native staged cycle: all 16 selected gates PASS, zero failures/pending repairs. Full remote stability: 5/5 full-unit runs, 8 load slots, 1624 seconds. Seven fleet smoke tasks plus two infrastructure canaries passed, with native owned cleanup.
- Existing quarantine results remain visible: the native summary reports 10 unique quarantined checks passed, zero failed (11 raw QUARANTINED_PASS observations include repeated browser-provider rows). No overrides or waived failures. CodeRabbit recorded no-reviewable-paths per repository path filters; independent flakiness review is separate.
- External-provider warning: Anthropic credential-health HTTP 400, credits exhausted. The warning-only check finished with six passing integrations, one warning, no failed checks. No credits were purchased and no credentials changed.

## Preservation

The initial archive preserves all inherited Git refs (including one local-only branch and the inherited stash), original native failure/custody records and historical repair material. The configuration archive preserves complete ignored configuration without changing it. Both have native full authenticated readback and independent verification. A supplemental archive/receipt records the final gates and production evidence. Recovery uses the existing `docs/handoffs/whm-b07d9037-preservation/private_archive.py` verify/restore commands with an empty destination; never overlay active configuration.

No Freedom setting or protected instruction was changed. No unowned process was killed. The earlier old-Claude process observations were absent from the later native process audit, without agent intervention. The box is not deleted by this work.

## Production and cleanup

Production semantic workflow [43949838339](https://github.com/Rose-Ai-Labs/rose/actions/runs/43949838339) passed all five jobs on exact merge `1ec28940191764ecf435ffc38b345006269bc95b`: frontend semantic flows and agent-plan, web-search, agent-execute, direct-answer lifecycle ratchets. Runtime deployments and payment probes were not applicable. The native production receipt retains source-equivalent frontend binding and exact merge/source IDs.

The timing/outcome command completed and published 21 native factory-ledger rows. Final deletion readiness is recorded by the native checker, rather than inferred from passing tests. Earlier dormant processes disappeared without being signalled; no unowned process was killed.

Final native readiness receipt has `ready: true`, `open_items: []`; the CLI requires that receipt to be committed and merged in this records PR before final READY certification. No old processes remained and no process was signalled.
