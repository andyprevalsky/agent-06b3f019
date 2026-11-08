# RCA process feedback — what the human has actually told us

Rules the user has given, repeatedly and often with frustration, about **how** to
diagnose and fix things in this repo. This is separate from `cases/`: a case file
records one incident, this records the standing corrections that apply to every
incident.

Read this at Step 0.5 of `/RCA`, before proposing a fix. Almost every entry below
exists because an agent already tried the shortcut and was told no. Re-proposing
one costs an approval round and erodes trust.

Each rule cites its origin so the reasoning is auditable. `memory:<name>` refers
to the persistent memory store; case ids refer to `docs/rca/cases/`.

---

## A. What is not a diagnosis

1. **"Pre-existing" is never a diagnosis.**
   Why: a repo maintained by many parallel agents degrades on every commit if
   nobody owns the errors they walk past. If you found it, you own it.
   Source: `memory:feedback_fix_preexisting_tests`, `memory:feedback_clean_tech_debt_in_scope`, CLAUDE.md rules 16/24.

2. **"Infrastructure issue" is a diagnosis that demands a fix, not an excuse to skip.**
   Why: expired tokens, Temporal connectivity, and slow agents are all fixable.
   Dismissing them as environmental was the exact move that produced the user's
   "I DONT KNOW HOW MANY TIMES I HAVE TO SAY IT."
   Source: `memory:feedback_no_failing_tests`, `memory:feedback_smoke_test_diagnosis`.

3. **A theory is not a deliverable.** "Probably load / a race / a 404 / third-party
   state" does not close an RCA. Reproduce it, or classify it honestly as an
   observability gap and keep it open.
   Why: unreproduced theories produce unverifiable fixes.
   Source: the hard gate in `docs/root-cause-analysis.md`, CLAUDE.md rule 6.

4. **Surface errors are not root causes.** Not "timeout at 300s" but "the browser
   agent made 12 LLM calls averaging 8s each because screenshot processing is
   slow." Read logs, trace execution, count specifics.
   Why: surface reporting forces the user to ask the follow-up questions you
   should have already answered.
   Source: `memory:feedback_diagnose_not_surface`.

5. **Correlation is not causation, and a prior case is not evidence.** A matching
   archive entry narrows the search; your own runtime evidence still has to point
   at that boundary.
   Source: `docs/root-cause-analysis.md` anti-patterns 7 and 8.

## B. Fix shapes the user has explicitly rejected

6. **Never relax a bound to make a failure pass.** No bumping timeouts, caps,
   ceilings, ratios, p95 multipliers, `AGENT_STALL_SECONDS`, or task budgets.
   Called out verbatim as "effortless cap-bumping bs."
   Why: the failure encodes information that the system is broken or slower than
   acceptable; relaxing the bound discards the signal and ships the regression.
   You may propose a cap change only with a latency profile and explicit
   agreement first.
   Source: `memory:feedback_no_cap_relaxation`, CLAUDE.md rule 25.

7. **Never relax a contract, validator, or evaluator to make a benchmark pass.**
   When the harness rejects an apparently valid value, first check whether the
   agent _could_ have produced an accepted value and didn't — then fix the
   prompt, schema, or behavior. Escalate to changing the contract only when the
   contract is genuinely wrong.
   Why: this is reward hacking; it hides the real agent-loop or product defect.
   The ecommerce descent proposed special-casing `offeringKind` so
   `request_payment_card` would accept a missing rating; rejected. Ground truth
   was that the validators already accepted `"0 stars"` and the tool schema never
   taught the agent the zero case.
   Source: `memory:feedback_descend_no_contract_relaxation`.

8. **Fix the general case, not the special case.** When an RCA finds one piece of
   injected state missing after a reset, re-initialize _all_ injected state — do
   not bolt on a handler for the one that broke.
   Why: the user reframed a passkey-specific rehydrate into "re-init should be the
   default for ALL injected state." Point fixes leave the siblings broken.
   Source: `memory:feedback_descend_no_contract_relaxation` (H-04).

8a. **If the first-bad write killed the agent, stop killing — do not add a
recover-after-death path as the product fix.** Showing cutover-FAILED
agents in SMS context so a late `approve` can restart them was rejected:
the question is why force-clear marked the parent FAILED.
Why: a recovery fallback leaves the next deploy still able to randomly
kill parked approval-waits. Replace onto the live generation instead.
Source: `2026-09-29-force-clear-kills-approval-blocked-cutover-stragglers`.

9. **Never disable a linter or type-checker to clear a gate.** No
   `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `# noqa`, `# type: ignore`,
   `ruff: noqa`. Remove existing disables in files you touch.
   Why: a disable buries the debt and tells future readers it is fine. Rejected
   when used to paper over 66 pre-existing SMS/chat eslint errors.
   Source: `memory:feedback_no_linter_disables`, CLAUDE.md rule 22.

10. **Never add a fallback that masks a third-party or configuration failure.**
    Surface it loudly. A silent fallback converts a visible outage into an
    invisible one.
    Source: `docs/root-cause-analysis.md` Step 4, CLAUDE.md rule 8.

11. **Never truncate anything that becomes part of an LLM prompt.** Tool
    descriptions, system prompts, docstrings — send them in full. Forbidden
    patterns: `_first_nonempty_line(...)`, `splitlines()[0]`, `prompt[:N]`,
    `description.split("\n")[0]`.
    Why: silent truncation strips tool knowledge the agent was supposed to have,
    producing wrong tool selection and worse output. UI-only display truncation
    is fine.
    Source: `memory:feedback_never_truncate_prompts`, CLAUDE.md rule 13.

11a. **Before a prompt edit, climb one level of abstraction deeper.** Name the
problem class, then try a more general solution that would eliminate that
class — or the class of class, or the class of class of class. Only stop
when the more general solution **fails to be coherent**. Record the
next-deeper class you tried and the one-sentence reason it failed.
Why: prompt tokens that name the incident, the benchmark, or one captured
miss overfit the instance and leave the class intact. The failed deeper
attempt is the anti-overfit proof; without it the Problem is too specific
to edit a prompt against.
Source: `/RCA` Step 5b, user instruction 2026-09-09.

11b. **Never add a keyword classifier that mutates model-chosen schemas,
    spawn routing, DAG tools, or completion text.** Persist the fields the
    model emitted. Do not inject, strip, rewrite, or cap from goal
    substrings (`Purchase Price`, `consolidate`, `MUST NOT use browser`,
    `one explore sub-agent per city`, `fast mode`, …). Keep
    `is_oai_demo_goal` as the one catalog-scoped demo exception.
    Why: the classifier is a second source of truth that fights the model. It
    required `order_confirmation_id` on a send-Aman offer because the attached
    catalog said `Purchase Price` / `Source Order Id`. Tightening the regex is
    still the same rejected layer.
    Source: `docs/rca/cases/2026-09-29-purchase-noun-markers-classified-offer-as-buy.md`,
    user 2026-09-29 ("the model determine the schema, not hacky classifiers on top";
    "keep is_oai_demo_goal / rm the rest").

## C. How to prove it

12. **Validate credentials and integrations through a blackbox, never ad-hoc
    curl/python.** A raw curl tests one hop and misses stale DB credentials, the
    wrong encryption key, sandbox env propagation, and CLI retry behavior.
    Extend the blackbox suite if no test covers the case.
    Source: `memory:feedback_validate_via_blackbox`, CLAUDE.md rule 18.

13. **Verify agent behavior through our own harness, not by hand-driving the
    third party.** Direct probes use different transport, selectors, and flow than
    production, and have repeatedly misled. Probes isolate a lever; only the
    harness delivers a verdict.
    Source: `memory:feedback_verify_through_harness_not_direct`.

14. **A benchmark failure needs two proofs.** The owning-boundary repro proves
    causality; the exact unchanged benchmark proves the outcome. A unit test,
    mock, simulator, fixture replay, or "benchmark-like" test is supporting
    evidence and never a substitute.
    Source: `docs/root-cause-analysis.md` exact-benchmark-outcome gate, CLAUDE.md rule 6.

15. **A green run on the wrong target proves nothing — read what the tool printed.**
    `DATABASE_URL=<local> npx prisma db push` still hit PROD, because the
    datasource sets `directUrl = env("DIRECT_URL")` and `.env`'s prod value won.
    Override BOTH vars and verify the printed `Datasource "db": ... at "..."` line.
    Source: `memory:feedback_prisma_directurl_prod_trap`.

16. **A 200 OK from the wrong model is a failure.** If Rose returns
    `actual_model=gemini/*`, every Claude token in the pool errored — that is a
    broken pool, not a pass. Assert on the model family, not on success.
    Source: `memory:feedback_gemini_means_claude_failed`.

17. **Beware fake failures.** Wrong `DATABASE_URL`, missing env, stale services,
    or leftover processes produce failures that are not the bug. Confirm the repro
    reproduces the harness's real conditions before diagnosing it.
    Source: `docs/root-cause-analysis.md` hard gate.

18. **Every fix lands a test in a consistently-run suite.** Behavior with no
    cemented test is assumed broken; a bug fixed without a regression test will
    silently return.
    Source: CLAUDE.md rules 1 and 2 (Testing); back-end/CLAUDE.md rule 3.

19. **Semantic/browser failures are real failures.** Fix them; start the
    dependency you need. The only acceptable escalation is a third-party provider
    out of credits.
    Source: `memory:feedback_semantic_tests_no_workarounds`.

## D. How to run the investigation

20. **Diagnose before re-running.** A re-run without a fix costs 3–10 minutes and
    proves nothing. "You should be immediately diagnosing the failures WITHOUT
    RUNNING THEM AGAIN UNTIL YOU HAVE A FIX IN PLACE."
    Source: `memory:feedback_diagnose_before_rerun`.

21. **Re-run only the failed subset, always in parallel.** Serial full-suite
    re-runs burn 25 minutes to re-prove tasks that already passed. Serializing is
    never the fix for contention — diagnose the contention.
    Source: `memory:feedback_rerun_only_failed`, `memory:feedback_benchmarks_always_parallel`.

22. **Never passively await a background task.** Poll every 10s for the first 60s,
    then every 60s, checking both output growth and liveness. The wake-up may
    never come: tasks get SIGKILLed under resource pressure, and a leaked cloud
    fleet bleeds money while you idle. One such stall leaked 7 paid Fly machines.
    Source: `memory:feedback_never_passively_await_async`, CLAUDE.md rule 1.

23. **Never kill or reap a resource you did not create in this session.** Broad
    patterns (`pkill -f run-bench`, `docker ps | grep bench`) match other
    worktrees. A broad docker grep killed a neighbor's live benchmark DB and
    produced 394 connection errors in their backend. Scope to this workspace's
    prefix, or read the run's own `services.json`.
    Source: `memory:feedback_never_broad_docker_bench_cleanup`, CLAUDE.md rule 27.

24. **Never `git stash`.** The ref is shared across worktrees; parallel agents
    overwrite each other's work. Use
    `git diff HEAD > .git-wip.patch && git checkout -- .` and reapply.
    Source: `memory:feedback_batch_workers_git_stash`, CLAUDE.md rule 21.

25. **Iterate locally, not by hot-deploying to prod.** The local cycle is far
    faster and cannot break prod. One agent deployed to Fly without smokes and
    broke every explore agent in production.
    Source: `memory:feedback_iterate_locally_not_prod_fly`.

26. **Take the obvious speed win without asking.** Smallest reliable scope that
    answers the question; parallelize independent tiers; kill stuck processes
    instead of waiting out a timeout.
    Source: `memory:feedback_optimize_for_speed`.

## E. When to stop and ask

27. **Escalate only for third-party credit/billing exhaustion (402, "insufficient
    credits") or a genuinely irreversible/costly action.** Everything else is
    yours to diagnose and fix; the user has standing authorization to keep going
    until the real-world outcome is achieved.
    Source: `memory:feedback_smoke_test_diagnosis`, CLAUDE.md rules 0/0a.

28. **Never enter payment card credentials.** A live purchase runs through the
    agent using an on-file payment method, and needs explicit approval at run time.
    Source: `memory:feedback_verify_through_harness_not_direct`.

29. **Prompt approval is snapshot-scoped.** Approval covers the diff that existed
    when it was requested. If a later fix touches prompt-related files, request
    fresh approval for those hunks.
    Source: CLAUDE.md rule 26.

---

## Adding to this file

When the user corrects an RCA in a way that generalizes beyond the incident, add
the rule here **and** record the incident-specific version in that case's
`## Human feedback` section. Keep entries in imperative mood with the `Why:` that
makes the rule stick — a rule without its reason gets rationalized away by the
next agent.
