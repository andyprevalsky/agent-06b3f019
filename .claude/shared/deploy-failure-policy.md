# Deploy failure ownership and exceptions

This is the controlling test/gate-failure policy for `/deploy`, including test
tiers, provider checks and production checks it invokes. Review-provider
outages or exhausted credits follow the external exception below. A review
comment about the exact recorded qualifying test/gate failure may reference
its existing handoff; independent correctness/security review findings retain
the existing review requirements. This policy does not create a general
waiver for review findings. It supersedes older blanket requirements to fix
every qualifying test/gate failure in the deploying agent's PR. Preserve the
intended whole-workspace deliverables; separate repair ownership does not drop
another contributor's intended feature from the release.

## Attribution and ownership

Diagnose every test/gate failure with `/RCA` before deciding ownership or an
exception. Use its evidence-backed `Gate: INTRODUCED` or
`Gate: NOT_INTRODUCED` response; do not classify independently of that diagnosis.
An unresolved RCA attribution stays UNKNOWN and cannot receive a waiver.
The attribution response does not require completing a separate repair first.
Independent repair delegation requires an existing test or required test gate
that actually ran and FAILED. Supply its exact command, test name, scope,
verbatim emitted error, source revision and native failure evidence. A code
observation, suspected secondary defect, skipped test or unexecuted check does
not authorize a repair delegate. Do not invent a test after the observation
to retroactively justify the delegation.

- **INTRODUCED:** evidence links the failure to this deploying agent's changes,
  including its repairs or integration work. The deploy owner owns it; it
  blocks deployment and cannot receive a delegation waiver.
- **NOT INTRODUCED:** evidence establishes that the failure was not introduced
  by those changes. Read relevant existing repair agents before editing a fix.
  If uncertain about a match, exchange distinguishing evidence with the owner.
  Before merge, retain the failed-test handoff packet in the existing deploy
  report and continue toward merge with that exact failure qualified as pending
  post-merge delegation. Do not create a repair delegate before the originating
  PR has merged to main. After merge, deliver the full repair goal to the
  matched owner or create a separate repair agent through the active backend
  below. Successful post-merge goal delivery or instructed creation completes
  the handoff: no acknowledgement, status handshake or repair completion is
  required by the originating deploy. Record the actual repair link and waiver,
  then continue immediately. Pending handoffs must be dispatched before the
  originating deploy can report completion.
- **UNKNOWN:** establish attribution before granting a delegation waiver.
  An unrelated filename, an unexplained timeout or a missing baseline is not
  evidence of NOT INTRODUCED.

Match by reading actual work and evidence, not fingerprints, matching titles
or automatic similarity decisions. Different symptoms can share one repair;
identical errors can have different causes. Reconcile overlapping discoveries
before duplicate repair edits. The repair agent follows `/RCA`; this policy
does not prescribe its implementation strategy. Do not create a task board,
ownership leases, acknowledgement protocol or mandatory status labels.

## Post-merge autonomous repair goal

Create repair delegates only after the originating PR is confirmed merged.
Use a new devbox from current `origin/main`, and verify that it contains the
originating merge before beginning the repair. Never fork the deploying
agent's pre-merge branch or uncommitted workspace. Existing matched repair
owners must also bring their work onto current main containing that merge.
Production test failures discovered after merge can be dispatched immediately.

Every repair delegate is unmonitored and must work fully autonomously; nobody
will answer its questions. Start its built-in `/goal`, not just an ordinary
diagnosis task, with this completion condition and the concrete failed-test
packet filled in:

```text
/goal Fix <exact failed test> within <scope>, make the original failing
command pass, and finish /deploy through merge, production verification,
cleanup and a completed deploy scorecard.

Failed test: <existing test name>
Command: <exact executed command and relevant invocation settings>
Scope: <affected behavior and boundaries to preserve>
Exact error: <verbatim native test failure>
Failure evidence: <accessible original log/artifacts>
Failed source: <revision that produced the failure>
Originating merge: <confirmed main merge revision>

Read CLAUDE.md and follow /RCA. Work autonomously from current main;
do not ask questions or depend on human replies. Resolve implementation
choices using the existing instructions and evidence. Prove the assigned
test passes, then carry the fix through /deploy to its completed scorecard.
An OPEN diagnosis, observability report, draft PR or stopped investigation
does not complete this goal. Do not waive or re-delegate the assigned test
as a substitute for fixing it. Preserve test intent, assertions, timeouts
and existing permissions; never fabricate success. Keep working until
the goal is achieved, including ordinary review and production work.
```

Set native goal state when the harness provides goal tools; a quoted `/goal`
line or promise to continue is not an active goal. Missing evidence is work
to resolve, not an acceptable diagnosis-only final deliverable. The deploy
owner does not monitor or wait for these independent repair goals.

New repair delegates always use **high effort and normal speed**, overriding
the parent's inherited effort/speed and any faster fallback. On boxes.dev,
normal speed is `--speed standard`: pass `--reasoning-effort high --speed
standard` explicitly. Never use fast or ultrafast for these delegates. Keep
the parent's model/harness, verify supported options before launch, and do
not silently substitute an unsupported effort or speed.

## External provider failure: no handoff

Evidence of a third-party outage or exhausted provider credits makes the
affected check non-blocking. Preserve its actual result and continue without
waiting for recovery, replenishing credits, automatic retry loops, or creating
any repair agent. An unexplained failure or an agent-introduced provider
configuration defect does not establish this external exception.

At the very end of every deploy scorecard, after all other sections, append:

**🚨🚨 EXTERNAL PROVIDER FAILURE — <provider>: <outage or credits exhausted> — NEEDS FIXING**

List affected checks and evidence under each provider. Keep unresolved alerts
across scorecard refreshes, resume and the final report. Do not turn failed or
unexecuted work into PASS. These exceptions do not authorize purchases,
credential changes or unrelated destructive operations.

## Active backend: boxes.dev

Deploy repair discovery, reading, communication and spawning currently use
boxes.dev. Rose account commands are implemented but default-off behind
`ROSE_ACCOUNT_AGENTS_ENABLED=true` in both the CLI and backend. Enabling them
for deploy repairs belongs to the separately authorized migration branch;
this deploy does not authorize Rose spawning. Do not enable the flag in
production as part of this release. Tests may opt in only in their isolated
processes and disposable databases.
Spawning also requires a signed, source-bound grant for the exact instruction
and request ID. Current workspace preparation does not issue these grants; trusted
issuance belongs to the separate migration.

Use the boxes.dev read/delegation skills and these commands:

```bash
dvb-onbox threads list --scope project --json
dvb-onbox threads read --scope project --thread <thread-id> --turns 10 --json
dvb-onbox threads send --thread <thread-id> --prompt-file evidence.md --idempotency-key <discovery-key> --json
dvb-onbox threads options --agent codex --json
dvb-onbox threads start --target new-devbox --agent codex --model <verified-parent-model> --reasoning-effort high --speed standard --muted --prompt-file handoff.md --idempotency-key <handoff-key> --json
```

Follow returned pagination cursors with `--cursor`; read the actual work before
matching. Use the deploy owner's harness/model and this policy's explicit high
effort/normal speed. Verify the child's effective settings after launch. Run
the start command only after merge, with the complete `/goal` packet above.
The new thread owns its repair through its own completed deploy; successful
creation or evidence delivery is the handoff, without an acknowledgement or
completion wait. Retain the returned permanent boxes.dev thread URL in the
scorecard. Do not archive an outstanding independent repair just because its
originating deploy finished.

## Rose commands: gated migration reference

Repair agents live in production **Rose / Bugs**, project
`1ec468d5-95dc-4754-a385-1c9abe784cd4`, folder
`18cb4c74-55f4-4f2e-a432-c5e7c7604f15`. The authenticated account must own that
placement. These `rose-agents` commands are for authorized isolated tests now
and for the future migration; they are not this deploy's active repair backend.

```bash
rose-agents list --scope account --project 1ec468d5-95dc-4754-a385-1c9abe784cd4 --folder 18cb4c74-55f4-4f2e-a432-c5e7c7604f15 --limit 20 --json
rose-agents read <agent-id> --limit 30 --json
rose-agents send <agent-id> - --scope account --id <discovery-key> --json < evidence.txt
rose-agents spawn --project 1ec468d5-95dc-4754-a385-1c9abe784cd4 --folder 18cb4c74-55f4-4f2e-a432-c5e7c7604f15 --title "--ai-- Test repair: <failure>" --goal-file handoff.md --instruction-file .claude/commands/deploy.md --id <handoff-key> --json
```

Read pages using the returned `next_command` until relevant claims have been
examined. Follow a message's `more_command` for its remaining text. Titles
help discovery but never establish a common cause. Account listing includes
unfinished work even when its agent is idle.

The handoff contains the complete failed-test `/goal` packet above, including
the exact error, scope and originating merge. Local-only files are
not available to a new Rose agent: provide accessible evidence or attachments.
Reuse the same request key and identical arguments after ambiguous delivery.
Successful creation returns the independent agent ID and URL immediately.
Do not wait for it as a prerequisite to this deploy.

Rose spawn is usable only when applicable existing instructions specifically
authorize it. This `/deploy` keeps `rose-agent-spawn: false` until migration.
The CLI requires `--instruction-file` pointing at that instruction's explicit
`rose-agent-spawn: true` declaration. Tool discovery, general autonomy and an
agent's own desire to delegate do not authorize independent spawning.

## Deploy report and scorecard

Keep a cumulative **DELEGATED** section containing only each handed-off
failure's description and repair-agent link. Every entry is implicitly NOT
INTRODUCED and waived for this deploy; do not add an attribution column.
Preserve the entries across updates and resume. Retain original failures in
TEST_REPORT and the PR body as `Delegated / waived`, never PASS.

Use the existing deploy run's report directory for durable cumulative entries.
`python3 scripts/deploy_failure_report.py record --report <run-dir>/failure-report.json`
reads one JSON occurrence from stdin: `id`, `description`, `evidence`,
`native_result`, `attribution`, and either `repair_agent` (the boxes.dev thread
URL, or a retained Rose URL) or
`external_provider` (`name` and `reason`: `outage` or `credits exhausted`).
Copy the returned RCA gate value into `attribution` (`INTRODUCED` or
`NOT_INTRODUCED`) and reference its diagnosis in `evidence`; use `UNKNOWN` while
attribution remains unresolved. Older `NOT INTRODUCED` records remain readable.
No acknowledgement field exists. The helper rejects introduced/unknown
delegation waivers and external-provider handoffs. The same `render` command
reads the base scorecard from stdin and appends cumulative delegated rows and
the external-provider alerts last. Its JSON also supplies the same rows to an
HTML scorecard; renderers must preserve their placement and native results.

Pre-merge pending packets are not completed handoffs: keep them in the existing
deploy report until actual post-merge dispatch. Do not invent a repair link or
record `Delegated / waived` in this helper before that dispatch succeeds.

The delegating deploy can complete while those repairs and external-provider
alerts remain outstanding. Its own introduced failures, unknown failures and
all other applicable requirements remain blocking. Do not rerun a failed
aggregate solely to conceal a qualified exception; preserve its native exit
and identify exactly which constituent failure was waived. An unexecuted
remaining check is still unverified and must be run.
