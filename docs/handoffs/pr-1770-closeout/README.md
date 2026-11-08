# PR1770 closeout

Application PR: https://github.com/Rose-Ai-Labs/rose/pull/1770
Application merge: `5066feea73da4a966aa7655ccbc40ea8c26529a8`.
Reviewed source: `606fe7fe65ce8fc41addb2960c2c3e3f4d45cfbd`.

The shared realtime adapter now normalizes native database UTC timestamps and Agent identity before reconciliation. Retained production frames reproduce the main-agent row's incorrect **9h21m** label before the change and the correct **1h21m** label afterward. The user explicitly identified the main agent's work row. This is a web/backend release; the new Mac binary was not built or released.

## Validation and production

The frozen source has four actual quick PASS gates. All281 selected checks remain accounted for: four PASS,275 provider/dependency UNVERIFIED administrative qualifications, and two historical no-retry custody exclusions whose current behavior remains UNVERIFIED. No current-source controller or smoke PASS was fabricated. Earlier a966 smoke13PASS is historical. Source427 component executions (219 coordinator,122 focused frontend,18 warm,7 cloud,6 autoscaler) remain separately identified; source606's final sync changed records only. CodeRabbit was skipped under its exact-head spending-cap evidence: merged unreviewed by CodeRabbit.

Exact-merge Render, Vercel, endpoint probes and production semantics PASS. The raw production report remains **FAIL**, with two separate qualified exceptions:

- Mac release42472479080 failed `npm install` in `mac-app`, Electron `install.js` HTTP504, before build/sign/notarize/upload. The download origin/version was not captured; do not label this a proven GitHub-wide outage. Native cleanup completed. The earlier auto-tag step exited141 with cause OPEN; an atomic exact-merge tag recovery created `v1.1.296`, which started the real release but did not make the failed build PASS.
- Production payment rund379f0ec natively ERROR/exit1: a test-mode Stripe hold was paired with a live AgentCard transfer. The unchanged production identity admission checked tier/credits but not billing mode. Why that subscription was test-mode remains OPEN. This is an additional NOT_INTRODUCED defect assigned to an independent repair goal, not a provider credential exception or standing-stall PASS. The benchmark's verdict was10:51:02UTC; collection ended10:58:21UTC. Collector streams stopped and the root deletion was reported. The recording publisher refused a missing browser recording; no production FE approval link is qualified.

The source-bound negative finalizers preserve original native receipts, flags, failures, repair history and financial obligations. They provide administrative policy qualification, never execution/PASS credit. Exact operators, journals, actual verifier invocations, native evidence and review limits are preserved privately. `production-qualification.json` binds the original failed production report to the two narrow canonical decisions.

## Independent repairs and financial duties

Five actual independent Bugs handoffs are recorded in `closeout-manifest.json`: C15 cooldown-fixture interference; unlocalized report-bug fetch failure; the matched existing org401 owner; Mac auto-tag exit141; and production mixed-mode admission. Their goals own their own completed deploys. Creation/delivery, native goal and folder evidence are retained; this originating deploy does not wait for their completion. Requested settings were Codex gpt-6.1-sol/high/standard; native service-tier introspection is a recorded platform gap, not an inferred effective measurement.

Two earlier sandbox allocations were last recorded unreleased4396c EACH and remain financially UNVERIFIED. The new production allocation was last recorded live100c, transferred100/released0, CLOSED card balance0, purchaseHELD/fundingRECLAIMING/refundnull. Financial cleanup failed; zero reported generic cleanup failures gives no refund/release credit. These modes are distinct and are not summed as real expenditure. Never mint/reclaim/reissue the three original cases as a repair shortcut.

Separately, the PR1784 coordinator accepted a post-merge compatibility follow-up for alternate state-directory custody admission and typed preallocation refusals, observed on its sourcef8a33aa856. Its fresh canonical-directory cycle avoids the failure. The future repair must preserve canonical no-remint history and fail-closed unknown states; a blanket locator bypass is not authorized. That follow-up goal is planned after PR1784 merges, not yet created/completed, and is not counted among the five delivered repair goals. No originating native grade was changed for it.

## Preservation and deletion readiness

`archive-receipts.json` records the encrypted final workspace core, the72-ref branch archive, and the independently verified historical-custody exports. The first custody export omitted older discovery rows and first-fleet closure files; use its **V2 closure supplement**, not the base alone. Original files remained intact; no proof was reconstructed or retimestamped. Both unchanged historical validators passed on the originating files, and every exported file was independently restored and hashed.

The complete core contains needed ignored configuration, original evidence/native audits, private operators/proofs, selected original temporary test logs and preservation metadata. Source is recoverable from main plus72 archived historical refs and two supplemental commit bundles. It contains no restored live ownership claims; six historical inventory symlinks are recorded as metadata. See `RECOVERY.md` before restoring anything. Production and finalizer raw failures remain unchanged.

The deletion JSON is deterministic and is committed here. Its initial local `ready:true` alone is insufficient: the records-only PR must merge, then the real `deletion-check` must exit0 with `DEPLOY_DELETION_CHECK READY`. The final published HTML retains that actual invocation, app/records ancestry, verifier certificates and scoped warnings. Late records/recovery/HTML evidence is preserved by this main commit and the published visual; it is not falsely claimed to predate the encrypted core snapshot.
