PR #2221 closeout: workflow-restart-tools "concurrent success and deploy reconciliation produce exactly one terminal
result" repair (PR #1946 deploy round 6, backend-coverage-blackbox/units). Merged 55655e654472 (RCA-only).

Root cause: the failed source 223f3877 predates 917e6bc6f1 (#1955/#1956). Its gate VM ran deploy-gate-setup.sh
from that commit and kept Postgres max_connections=100, so a connect was refused ("Too many database connections
opened: FATAL: sorry, too many clients already"). The Message_agentId_fkey errors are withAgent teardown racing the
sibling in-flight inserts after Promise.all rejected. No code or test change: main already carries the fix.
RCA: docs/rca/cases/2026-11-11-gate-vm-postgres-stock-max-connections-below-coverage-pool-budget.md
("2026-11-15 occurrence" section).

evidence/
  pr1946-round6-units.log.gz             original failing units log (PR #1946 round 6, source 223f3877)
  local-repro-summary.json               per-run exit / PASS-FAIL / sampled peak clients / "too many clients" count:
                                         cap100-hold90 FAIL (same case, same FATAL); cap300-hold90 PASS + 5/5 PASS;
                                         cap100-noload PASS (peak 17); reviewer-hold60 = independent reviewer run
  backend-coverage-blackbox-manual-run.json + run43690209043-units.log.gz
                                         the original failing command on PR #2221's frozen HEAD 546242327b
                                         (Blacksmith run 43690209043): 272/272 PASS, units 459/459 incl.
                                         workflow-restart-tools.test.ts, coverage-threshold PASS
repro/  hold.sh, sampler.sh, unitpass.sh  harness (adapted from docs/handoffs/pr-1955-closeout/repro/, OUT dir
                                         /var/tmp/rca-restart) against a private PG16 cluster on port 5441

Production: semantic lane PASS-verified-by-descendant (run 43805716638, live frontend e5819032558f). The first
semantic run 43691173465 failed entry-load-recovery.spec.ts:156 (Expected 2, Received 3) during concurrent Vercel
promotions (f6a9e3b47b 07:44:15Z, 8207c0b361 07:44:19Z); NOT_INTRODUCED, evidence delivered to the existing owner
thread https://boxes.dev/thread/ph7asdf6a54w6mm0tpzkd0e79d8j8jpg.
Private archive: private-archive-receipt.json (.context incl. .context/pr2221-scratch and local logs).
