PR #2324 closeout: main-red repair of deploy-command-structural
RelayStartupEvidence.test_campaign_persists_fixed_commands_before_any_controller_admission (78 != 1).
Merged 98f94251658a (tests + RCA only).

Root cause: 5d5388739f added the up-front delegating-guest ceiling refusal (exit 78, default 70) to
run-bench-campaign main() and gave its other wide fixtures CLOUDBENCH_DELEGATING_PRIMARY_CEILING, but missed this
600-wide fixture. Fix: the same override (600) in the test env; real preflight still runs, width and every
assertion unchanged. Red on 12d54fa2b0, green 5/5 after.
RCA: docs/rca/cases/2026-11-16-delegating-ceiling-preflight-missed-600-wide-relay-campaign-fixture.md

Gates: 15/15 PASS on 8d02e7dc440d (deploy-command-structural PASS, smoke 7/7 PASS).
Production: semantic lane PASS-verified-by-descendant (chat-lifecycle-ratchet run 43815321653, live frontend
530b71fe93a6). The first semantic attempt failed before testing: GitHub REST 403 rate limit on
`gh workflow run chat-lifecycle-ratchet.yml` (core quota 0/5000); rerun after the reset passed.
Private archive: private-archive-receipt.json (.context, 6802 files, full readback verified).
