---
id: 2026-11-07-worker-recipe-omits-timing-finalization
date: 2026-11-07
title: Reused worker roots retain completed jobs inside active timing contexts
surface: harness
component: deploy-worker-recipe-timing-lifecycle
classification: configuration-error
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Caller-supplied worker recipe completes its cases and service cleanup without finishing the timing context created by setup
symptoms:
  - deploy timing lifecycle error: deploy timing run already active
  - failed to initialize deploy timing run
  - setup failed or worker interrupted
tags:
  - deploy
  - worker-recipe
  - timing-lifecycle
  - stale-context
sources:
  - PR #1716
  - commit 1c0a5e56c2ddeddf20802f337aaa8bf183a86e3f
  - commit ed47d406bb5b17de8a4c5a291878edece7c64d61
  - commit 39bcd257dc6e1d731008b46e9611ee7f1a5f1723
  - commit 48a730a86092ad32c2270c3c59293ed357104c4d
  - plan:.context/pause-rca/nov7-timing-rca/runtime-summary.json
repro: .context/pause-rca/nov7-timing-rca/reproduce.py (ignored owning-boundary diagnostic; not permanent regression coverage)
status: open
---

## Problem

Final round 30 for live-probes, e2b-smoke and semantic-stack returned native exit 1,
receipt status FAIL, case UNVERIFIED, complete=false. No gate case executed:
setup's `bash scripts/run-deploy-stage --start` refused the pre-existing timing
context. The exact coordinator request/receipt/result and native worker logs are
copied byte-for-byte under `../evidence/round30/`. `../evidence-manifest.json`
records original absolute paths and SHA-256 hashes. The three errors name:

| Gate | Old timing run | Last stage terminal time UTC | Native finish UTC | Real terminal-to-finish gap |
| --- | --- | --- | --- | --- |
| live-probes | 20261107-073158-3675116 | 07:33:14 | 08:54:07 | 4853.203 seconds |
| e2b-smoke | 20261107-073148-3669535 | 07:33:03 | 08:54:07 | 4864.573 seconds |
| semantic-stack | 20261107-073147-3668365 | 07:55:23 | 08:54:07 | 3524.295 seconds |

Round 25 on 1c0a5e56 genuinely passed all three gates. The old contexts contain
four, one and two passed stage rows respectively. These old passes do not grant
credit to ed47d406. The parent had already run the supported native finish in
the exact idle roots before this investigation; the captured metadata says
completed, admissions are empty, and their current pointers were absent at the
08:55-08:56 observation. The old active status at the refusal is evidenced by
the native refusal itself, not fabricated by editing the later metadata.

## Diagnosis

Gate: NOT_INTRODUCED — scoped to the compared 1c0a5e56 → ed47d406 changes and
the shared native timing refusal. This is causal attribution only; no waiver,
new-source PASS or completed deployment is claimed.

The path is coordinator frozen request → worker recipe setup → native timing
start → old current pointer + active metadata → LifecycleError → setup failure
→ worker case UNVERIFIED → coordinator FAIL. The first violated lifecycle
contract precedes this observation: the prior caller recipe starts a timing
run but returns its root after case/service completion without native timing
finish. A terminal stage releases its own admission; it does not end the run.

Exact recipe comparison, round 25 versus round 30:

| Gate | Setup | Declared cleanup |
| --- | --- | --- |
| live-probes | bash scripts/run-deploy-stage --start | absent |
| e2b-smoke | bash scripts/run-deploy-stage --start | bash scripts/kill-services.sh |
| semantic-stack | bash scripts/run-deploy-stage --start | bash scripts/kill-services.sh |

The recipes are identical between those rounds. `deploy_test_worker.py:104-134`
runs the declared cleanup in finally and reports its success; `cleanup_complete`
therefore does not establish timing finalization. The worker explicitly assigns
provisioning and teardown responsibility to its caller. Neither case runner nor
kill-services calls timing finish. No evidence attributes this incident to an
LLM provider, a live job, a new timing guard, database work or a timeout.

`deploy_stage.py:157-165` refuses active/finishing metadata before creating the
new directory or touching the selected telemetry. `finish_lifecycle:267-310`
closes admission, waits for admitted stages, records real current finish time,
and removes the current pointer. A stage release alone only removes its own
admission. The correct boundary for this operational recovery is this existing
native finish, under the parent's verified idle-root ownership checks.

The apparent new enforcement is old: `git log -S 'deploy timing run already active'`
identifies 48a730a86092ad32c2270c3c59293ed357104c4d, July 18, 2026, 19:30:38
-07:00, `fix(deploy): serialize timing lifecycle`. Before that commit, start
could replace the pointer; the commit added rejection and serialized finish.
This historical fact does not justify restoring the overwrite behavior.

The following files are byte-identical in original 1c0a5e56, current ed47d406,
main39 resolved as 39bcd257dc6e1d731008b46e9611ee7f1a5f1723, and local origin/main
ed610138e77d20f120f5564ee13cb0d18276a452: deploy_stage.py, run-deploy-stage,
deploy_test_worker.py, run_deploy_live_probes.py, run-deploy-semantic-stack.sh,
kill-services.sh. Exact blobs and hashes are in `../source-provenance.json`;
empty per-file diffs are preserved under `../diffs/`. The three observed worker
roots were ed47d406 and their timing/worker bytes matched canonical source.
No fetch was performed; origin/main is explicitly a local ref observation.

Owning-boundary proof: `python3 .context/pause-rca/nov7-timing-rca/reproduce.py`
ran five consecutive times unchanged. It copies three native files byte-for-byte
to its ignored trial folder, uses an isolated DEPLOY_RUN_ROOT and no inherited
factory snapshot, starts one timing run, executes /bin/true, records and releases
that synthetic stage using native APIs, then runs an identical new-start command
before and after native finish. Before: exit 1 with the exact active-run refusal,
no new directory, old metadata/stage bytes/pointer preserved. After: exit 0 and
new active run. Native finish closes the second context as well. All timestamps
come from current real clocks. The original stage bytes never change. No
provider, DB, service cleanup, signal delivery, actual funded gate or current
worker timing context participates. Each trial's exact argv, environment
contract, outputs, return codes, code hashes and times are in its proof.json.
The first trial's refusal took 0.0885 seconds; finish took 0.1174 seconds and the
identical accepted start took 0.0780 seconds. This proves the lifecycle mechanism,
not an end-to-end gate pass.

Archive search: literal phrase plus behavioral query were run through
rca_archive.py, and literal `rg -F` had no matches. The closest archive relatives
were the backend fixture restore/cleanup-admission case and code-session native
lifecycle case; both Solution and Human feedback sections were read. They teach
ownership and native closure but do not establish this incident's boundary.
This exact issue has no located archive case. Local history does contain an
earlier semantic-only refusal (round 4, e8abcca6, old run
20261106-044548-2345427), preserved in `../earlier-semantic-refusal.json`.
Thus this is a recurring local symptom, not proven recurrence of an archived fix.

Adversarial self-review: current source did not add enforcement; service cleanup
does not imply timing finish; pre-existing passed jobs are not fresh gate credit;
late metadata alone cannot prove the earlier active state but the refusal does;
the earlier semantic occurrence is separate evidence; no source repair or
end-to-end success follows from a synthetic fixture. No independent reviewer
was spawned because the user explicitly prohibited subdelegation.

## Solution

Operational containment already performed by the parent: supported
`bash scripts/run-deploy-stage --finish` in each exact idle old root. Its
resulting completed state is observed and copied here. This investigation did
not repeat that command in any real worker root or touch current lifecycles.
Do not delete pointers, replace metadata, backdate timestamps, suppress the
guard, weaken the frozen recipes or rewrite original UNVERIFIED receipts.

No canonical source fix is demonstrated necessary to unblock the immediate
retry, and none was made. For future reuse, the owner must finish every timing
context it starts after its declared jobs are terminal, with existing native
admission and ownership guards. Any later automated pairing/recipe change needs
parent review and normal source-bound validation; it is not implemented here.
Removing a useful guard or silently adopting somebody else's active timing
context would make lifecycle evidence unreliable. Reusing native finish adds
no second state machine.

The parent retains all PR1716 /deploy ownership and must rerun all three actual
source-bound coordinator gates after its current cohort settles. Pending those
unchanged gate outcomes, this case stays open. No exact gate replay, permanent
regression registration, canonical archive insertion or broad deployment
validation was attempted under this bounded assistance scope. Golden reference:
not applicable (no approval-gated hunk).

## Human feedback

The user limited this assignment to ten-minute RCA assistance, prohibited
subdelegation, canonical source/dependency/DB edits, checkout changes, provider
calls and signals, and retained the parent's complete PR1716 /deploy ownership.
The user explicitly rejected backdating, rewriting refusals, false PASS and
waivers; preferred supported finish for completed prior timing contexts; and
required an ignored draft and exact evidence/proof under this directory.
The supplied parent settings are gpt-6.1-sol/xhigh, with ultrafast fallback
requested. Effective speed is unobservable; no setting change or speed claim is
made here. Scoped token counters are unmetered in this assistance record.

## Reusable lesson

Pair every owned timing start with native finish after its admitted jobs terminate before reusing that worker root, while preserving original failures and real timestamps.
