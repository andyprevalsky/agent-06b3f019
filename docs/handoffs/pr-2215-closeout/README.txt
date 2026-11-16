PR #2215 closeout: deploy-agents.yml `recover` relied only on GitHub's best-effort `schedule: */10`, which
fires every 4-7 h (one 23 h gap), so a failed worker-deployment FIFO head stalled Fly agent deploys for hours.
Merged 85f05ea3f9527058cd54657e83297a36cf267e1d.

Fix: `recover` now `needs: deploy` and also runs when the deploy job fails; both triggers run
scripts/deploy-agents-recover.sh, which only calls `worker-deployment-queue.ts run --job-id <head> --if-idle`
(global lease, FIFO head, 600 s failed-attempt cadence), polls a busy lease for up to 30 min and stops after
3 failed cutovers. Regression: scripts/tests/deploy-agents-recover.test.sh (gate deploy-agents-recover).
RCA: docs/rca/cases/2026-11-15-deploy-agents-recover-relied-on-sparse-github-schedule.md

Gates: READY on 99d53bcc14 (smoke PASS). INTRODUCED cooperative-cutover-monitor assertion retargeted to the
recovery script (fixed in-PR). live-probes Tilion west-region DNS parity: NOT_INTRODUCED, fixed on main by
#2236, owner thread ph7d9yt0132hkdgdtz86ytwgvn8j87a9. A 21 h devbox suspension voided one focused round
(remote run passed, coordinator lost it); it was re-executed. CodeRabbit: org usage cap, merged unreviewed.
Merge held for Fly-cutover coordinator ph7ddcbnp8hfhch4px8xz9k09n8j0jrd 'merge now'.
Production: fly PASS (deploy-agents run 43822304711), workflow-migration PASS, semantic
PASS-verified-by-descendant (chat-lifecycle-ratchet run 43829561159; first attempt hit GitHub REST 403 quota).
Private archive: private-archive-receipt.json (.context, full readback verified).
