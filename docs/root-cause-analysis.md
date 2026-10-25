# Root Cause Analysis Guidelines

These guidelines define how to diagnose bugs in this codebase. Follow this methodology exactly — do NOT skip steps. Invoke `/RCA` to run this correctly.

> ## ⛔ THE HARD GATE — read this first
>
> **You may NOT report a root cause without BOTH of these, executed locally:**
>
> 1. **A local reproduction you actually ran and watched FAIL** on the buggy code (record the exact command + failure output).
> 2. **A fix that makes that same reproduction PASS** (re-run the identical command; do not weaken the assertion).
>
> **Never come back with a theory.** "It's probably load / a race / a 404 / third-party state" is not a deliverable. If you cannot reproduce it, you have _preliminary findings + an observability gap_ — say so and keep the RCA open; do not present code-reading or correlation as a finished RCA.
>
> **Beware fake failures:** running a test the wrong way (wrong `DATABASE_URL`, missing env, stale/leftover services) produces failures that aren't the bug. Reproduce the harness's real conditions and confirm the repro is valid before diagnosing.
>
> **Benchmark failures require two different proofs.** An owning-boundary test
> proves causality; the exact unchanged local benchmark proves the reported task
> outcome. Neither substitutes for the other. Do not call a benchmark fixed from
> a unit test, mocked browser state, simulator, replay, or other proxy test.

## System Architecture (request flow)

```
User → front-end (React/Vite) → back-end (Express/Prisma) → Temporal → agent workflow
                                       ↓                        ↓
                                   Postgres DB            tools (spawn_agent, browser, etc.)
                                       ↓                        ↓
                                 Supabase Realtime        research (Rose completions/racing)
                                       ↓                        ↓
                                   front-end ←          external APIs (LLM providers, Exa, etc.)
```

Every bug lives on a path through this graph. Your first job is to identify WHICH path, then find WHERE on that path the data first goes wrong.

**Sources** (where data enters the system): user input, LLM responses, external API responses, DB reads, env vars.
**Sinks** (where data exits the system): UI rendering, DB writes, HTTP responses, Temporal signals, Supabase broadcasts.

## Step 0: Gather evidence before theorizing

Before forming ANY hypothesis, collect runtime evidence:

- Read the relevant log file (`agents/navi-worker-log.txt`, `back-end/backend-logs.log`, etc.)
- Read the actual error message, stack trace, or HTTP response body
- If the error is in agent execution, query the DB for raw message/event data
- Count specifics: how many messages, which tools ran, how long each step took

**Never reason about what "might" be wrong from code alone when runtime evidence exists.** The logs tell you what DID happen. The code tells you what SHOULD happen. Compare the two.

## Step 0.5: Search the RCA archive

`docs/rca/cases/` holds every RCA this repo has completed — problem, diagnosis, solution, and the human feedback given at the time. Search it once you have real symptom strings from Step 0, and before you form any hypothesis:

```bash
python3 scripts/rca_archive.py search "<exact error text> <route> <component> <symptom words>"
python3 scripts/rca_archive.py show <case-id>
grep -ri "<exact error string>" docs/rca/
```

Run at least two searches with different vocabulary: the literal error string, and the behavioral symptom ("agent hangs STARTING_UP", "0% cache hit", "works locally, fails in prod"). Read `docs/rca/process-feedback.md` as well — it is the distilled set of human rules for how RCA is done here, including fix shapes the user has explicitly rejected.

A hit is a **lead, not a verdict**. It tells you where to point the flashlight and which fixes were already rejected; it never satisfies the hard gate. Rules:

- Confirm the prior case's `first_bad_boundary` is where your own evidence points before adopting its diagnosis. The same symptom routinely has a different cause.
- Read the prior `## Solution` and `## Human feedback` before proposing a fix. Re-proposing a rejected approach wastes an approval round and erodes trust.
- If this is a genuine recurrence, the previous fix did not hold — **that** is the RCA. Diagnose why the earlier guardrail missed it and fix at that level, then append the new evidence to the existing case rather than creating a second one.
- No hits is information: you are in new territory, so widen evidence gathering instead of pattern-matching.

Record in the RCA which searches you ran and whether the incident is a recurrence, a relative, or novel.

## Step 1: Trace the critical path

Identify the full request/data flow the bug lies on — which services does it cross? Map the path from source (where the input originates) to sink (where the wrong output appears). Use the architecture diagram above.

Example: "Agent sends malformed message to user" → the path is:
`LLM response → run_agent.py parses response → tool execution → message_person.py → back-end API → DB → Supabase broadcast → front-end renders`

Write this path down explicitly before proceeding.

## Step 2: Binary search for the most upstream error

The symptom is where you NOTICE the bug. The root cause could be upstream, downstream, or at the point of observation. Binary search to find where data FIRST goes wrong:

1. Pick the midpoint of the critical path you traced in Step 1
2. Check: is the data correct at this point? (Read the log, query the DB, inspect the HTTP response)
3. If correct here → the bug is downstream. If wrong here → the bug is upstream or at this point.
4. Repeat until you find the FIRST place the data goes wrong.

**Fix at the most upstream point where the data is wrong.** A rendering bug in the frontend might be caused by a malformed API response, which might be caused by a wrong DB query. Fix the query, not the renderer.

## Step 3: Create a fast isolated reproduction

Once you have found the most upstream suspicious point, reproduce the failure locally in the smallest environment that still exercises the same mechanism. This is required before the diagnosis may be called an RCA, whether or not a fix will be written in the current task.

The isolated reproduction should:

- Use the same critical code path or boundary where the data first goes wrong
- Remove unrelated services, network calls, benchmarks, retries, and UI layers
- Run quickly enough to iterate repeatedly while fixing
- Fail before the fix and pass after the fix
- Preserve the exact behavior being diagnosed, not a similar but different bug
- Be promoted into the permanent, checked-in blackbox suite for the boundary that owns the bug before the fix is considered complete

If a unit-level reproduction would lose the behavior under investigation, use the narrowest local integration test, recorded-response replay, or benchmark checkpoint that preserves it. Do not use a full benchmark as the only reproduction when a smaller local test can prove the same causal mechanism.

### Exact benchmark outcome gate

When the symptom being diagnosed is a benchmark failure, the isolated
reproduction above is necessary but not sufficient. It answers "did we fix the
suspected mechanism?" It does not answer "does the reported benchmark now pass?"

Before describing a benchmark issue as fixed, approval-ready, verified, or
complete, run the exact task through the canonical local entrypoint on both sides
of the change:

```bash
scripts/run-bench --local <exact-existing-task-name>
```

Required evidence:

1. On the buggy revision, the exact task fails locally with the reported outcome
   or the same first-bad causal boundary.
2. On the fixed revision, the exact same command and task definition pass.
3. The prompt, evaluator, expected tools, fixtures, timeout, and pass criteria are
   byte-for-byte unchanged between those runs.
4. The run artifacts and working FE link are recorded for both runs.

Unit tests, blackbox tests, mocked browser states, simulators, recorded-response
replays, and benchmark checkpoints remain valuable causal and regression proof,
but they are **proxy evidence** for the task outcome. A proxy test may never be
reported as proof that the benchmark passes. A test whose fixture simply supplies
the desired post-fix result proves only that the harness can consume that result.

If the buggy revision cannot reproduce the exact failure locally, record an
outcome-reproduction gap and keep the RCA open. If the fixed revision still fails
the benchmark, treat that run as new primary evidence and continue iterating; do
not stop at the passing proxy test.

### Permanent deploy regression coverage

A scratch test, executable repro script, benchmark checkpoint, or fixture replay may be useful while reducing the failure, but it is not sufficient regression coverage. Once the reproduction fails for the diagnosed bug, preserve it as a checked-in blackbox test in the suite owned by the first-bad boundary:

| First-bad owned boundary      | Required permanent suite                                         | `/deploy` gate that must run it                     |
| ----------------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| Back-end API or service       | `back-end/src/tests/blackbox/<domain>.blackbox.ts`               | Step 5a: full back-end blackbox suite               |
| Agent, Temporal, tool, or LLM | `agents/tests/blackbox/<domain>.blackbox.py`                     | Step 4g: agent coverage runs the blackbox suite     |
| Front-end component or state  | `front-end/src/tests/blackbox/<domain>.blackbox.tsx`             | Step 4b: front-end coverage runs the blackbox suite |
| Mac app renderer or main      | `mac-app/tests/blackbox/<domain>.blackbox.ts` or `.blackbox.tsx` | Step 4m: full mac-app blackbox suite                |

The correct suite is determined by the layer that owns the first bad data or violated contract, not by whichever file happened to be edited for the fix. Reuse the captured request, response, event stream, or fixture from the isolated reproduction inside that blackbox test so it exercises the same causal mechanism and retains the same assertion.

The permanent blackbox test itself must be run against the buggy code and observed failing before the production fix is written, then run again unchanged and observed passing after the fix. Do not weaken the assertion, replace the captured failure with friendlier data, or leave the actual regression only in a unit test or scratch artifact.

For a cross-service or UI-visible regression, the owning-boundary blackbox test is mandatory. Add a smoke or semantic test as additional coverage when the user-visible failure cannot be proven at that boundary alone; higher-level coverage supplements rather than replaces the owning blackbox test.

Before closing the RCA, verify that the repository's blackbox runner discovers the new test and that `/deploy` invokes that runner for changes to the affected production surface. If it does not, update the runner or `/deploy` wiring as part of the fix. A passing test that future deploys skip does not satisfy this requirement.

### RCA completion gate

An RCA is **incomplete** until all of the following are true:

1. A deterministic reproduction artifact exists locally (an automated test, fixture replay, or executable repro script).
2. The artifact exercises the same code path or first-bad boundary identified by the runtime evidence.
3. The artifact has actually been run locally and demonstrates the observed failure on the buggy code.
4. The RCA records the exact command and the failure output or assertion that proves the reproduction.
5. If a fix is made, the same artifact passes after the fix without weakening its assertion.
6. If a fix is made, the reproduction is preserved as a checked-in test in the owning boundary's permanent blackbox suite; a scratch artifact alone is not sufficient.
7. The full blackbox runner that `/deploy` uses discovers and passes the new regression test.
8. `/deploy` is wired to run that blackbox runner whenever the affected production surface changes.
9. For a benchmark failure, the exact unchanged canonical local benchmark has
   been observed failing on the buggy revision and passing on the fixed revision;
   both artifacts and FE links are recorded.
10. A case file exists in `docs/rca/cases/` and `python3 scripts/rca_archive.py validate` exits 0 (see Step 8).
11. If the intended fix is a prompt edit, Step 5b is recorded: the class you stopped at, the next-deeper class you tried, and why the more general solution failed to be coherent.

### Autonomous fix, approval, and verification handoff

**If you can solve the issue without touching code that requires user approval
to deploy, do that and immediately run `/deploy`; drive it fully autonomously
to completion.** Do not stop after the evidence-backed diagnosis merely because
the current task was phrased as RCA-only.

After the local reproduction proves the root cause, determine whether the
correct generalizable fix requires a human-approval-gated change. This includes
prompt or other LLM-visible text, agent recovery/terminal semantics, runtime
trajectory injection, Zod schemas, benchmark definitions or timeouts,
production environment writes, irreversible or paid actions, and any other
surface that a repository rule explicitly says requires user approval.

- If the fix is not approval-gated, implement it immediately, complete the
  verification steps below, write and validate the RCA case, and invoke
  `/deploy` without an intermediate user handoff. Own the deploy through every
  test, review, merge, rollout, and production verification loop.
- If the correct fix is approval-gated, run the Golden-reference adversarial
  review in `.claude/shared/approval-format.md`; a `GROUNDED` verdict clears the
  gate. Otherwise stop at the narrowest approval boundary and request approval
  using that format. After approval, resume the same fix-and-deploy flow without
  another discretionary pause.
- Never choose a weaker point fix, fallback, test change, or wrong-layer
  workaround merely to keep the diff approval-free. Approval status determines
  whether to pause, not which technical solution is correct.
- An explicit user instruction to diagnose only or not modify/deploy still
  takes precedence.

For every implemented fix:

1. Implement the selected fix (or the approved fix when approval was required)
   without changing the reproduction's asserted behavior.
2. Run the exact same local reproduction command that demonstrated the pre-fix failure.
3. Report the post-fix command, exit status, and relevant passing assertion back to the user,
   alongside the recorded pre-fix failure.
4. If the reproduction still fails, the fix is not complete; continue the fix-and-test loop
   rather than reporting success.
5. For a benchmark failure, run the exact canonical local benchmark after the
   owning-boundary repro passes. Continue iterating until that exact task passes;
   do not hand off a proxy-test pass as benchmark verification.

Changing or weakening the reproduction so the fix appears to pass does not satisfy this
handoff. If new evidence proves the original reproduction targeted the wrong boundary,
record that evidence and establish the corrected reproduction before using it as the
acceptance test. Pause only if the correction or resulting fix crosses a human-approval
boundary described above.

There is no “not feasible” exception that turns unreproduced findings into a completed RCA. If production-only or third-party state cannot be recreated directly, capture and replay that state at the owned boundary. If the required request, response, event stream, or state was not captured and therefore cannot be replayed, classify the result as **preliminary findings plus an observability gap**, add the missing capture, and keep the RCA open. Do not present a hypothesis, code inspection, production correlation, or external-state explanation as a completed RCA without an executed local reproduction.

**Adding observability is never the stopping point — log, THEN keep going deeper in the same pass.** When you hit a missing log/capture, add it, but do NOT hand the RCA off with "I added logging, re-run and we'll see next time." That defers the diagnosis and burns another full failure cycle. In the same investigation you must keep pulling the thread with the evidence you already have: query the DB directly, decrypt/replay the stored artifact, diff the failing record against a passing one, audit the whole population for the same defect, and walk the write path that produced the bad state. The new log is insurance for the _next_ occurrence and a permanent capture for the boundary — it is not a substitute for driving _this_ occurrence to the deepest owned cause now. Stop only when you hit the genuine floor: a proven cause with a reproduction, or a rung that provably leaves what you own (Step 5a). "Logging added" with the root cause still unknown is an open RCA, not a finished one.

### Step 3a: Reconstruct failing LLM calls

If the suspected root cause is an LLM call, provider call, model gateway call, compute-token acquisition, tool-call parser response, or any other model-facing boundary, the isolated reproduction must start by reconstructing the exact failing LLM request locally from captured evidence.

Required reconstruction evidence:

- The full message list/context sent to the model
- The system prompt and tool/schema set
- The model name and provider/auth path used
- Generation config that can affect behavior, including reasoning budget, max tokens, response schema, tool choice, cache controls, and timeout/deadline settings
- The captured failure span/log line, including provider, request/span id, duration, timeout type, and any token/auth rotation metadata

The RCA is incomplete until you re-run the reconstructed call through the same local client path and reproduce the failure, then iteratively reduce or vary the request to identify which input/config/provider condition makes it fail.

Unavailable external state does not waive the local-reproduction requirement. Replay the captured provider response, token error, timeout sequence, or lease state through the same local boundary. If the evidence needed for that replay was not captured, the result remains preliminary until the observability gap is fixed and a subsequent occurrence or controlled replay provides the missing artifact.

Do not classify an LLM issue as "model/provider timeout" and stop there. Treat the LLM request as data: preserve it, replay it, diff it against nearby successful calls, and identify whether the failing condition is in our prompt/context/schema/config, our provider-routing/auth code, or a third-party service state.

### Model-intelligence proof protocol

**Model intelligence limitation** is a valid classification only when a
controlled replay proves that model capability is the causal variable:

1. Reconstruct the exact failing call from the evidence required above.
2. Run it through the same local client path with the original model and
   reproduce the failure.
3. Change only the model selection, keeping the messages, system prompt, tools,
   response schema, generation config, provider path, and client code fixed.
4. Show that the upgraded model passes the unchanged acceptance assertion.
5. When output is nondeterministic, report repeated trial counts for both models
   and show a clear separation; one failure followed by one success may be luck.

For example, the same captured call failing on Opus 4.8 and passing on Fable 5
can prove this classification. A simultaneous prompt, schema, tool, context,
routing, or generation-config change cannot: reduce the comparison until all
non-model variables are held constant.

## Step 4: Classify the failure

Not all errors are bugs in our code. Before writing a fix, classify:

| Classification                                                      | Example                                                                                    | Correct response                                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| **Our bug** — our code produces wrong output given valid input      | JSON parse error on well-formed LLM response                                               | Fix our code                                                                                                   |
| **Third-party failure** — external service returns an error         | 402 out of credits, 429 rate limited, provider outage                                      | Surface the error clearly to the user; do NOT add fallbacks that mask it                                       |
| **Input error** — bad data entered the system                       | Malformed user goal, missing required field                                                | Validate at the system boundary where the input enters; do NOT patch downstream handlers                       |
| **Configuration error** — missing env var, expired token, wrong URL | TEMPORAL_ADDRESS not set, expired Claude OAuth token                                       | Report the specific missing config; do NOT add "works without it" fallbacks                                    |
| **Test bug** — the test itself asserts the wrong thing              | Test expects old API shape after a schema change                                           | Fix the test, not the production code                                                                          |
| **Model intelligence limitation**                                   | The unchanged captured call fails on the original model and passes on a more capable model | Upgrade the minimum capable model or model-selection policy and preserve the controlled replay as a regression |
| **Unresolved** — an open RCA lacks proof for the other buckets         | A timed-out agent has model research turns, but replay does not establish a code, provider, or model-capability cause | Preserve the evidence and verification gap; keep the case open until a boundary reproduction supports a classification |

**The critical rule:** Third-party failures and configuration errors are NOT bugs in our code. Never write code to "handle" a 402 by falling back to a different provider silently. Never write code to "handle" a missing env var by using a default. These mask real problems. Surface them to the user.

## Step 5: State your hypothesis explicitly

Before writing any fix, state ALL of these:

1. **What** — the observed wrong behavior (the symptom)
2. **Where** — the root cause location (file, function, line)
3. **Why** — the causal chain from root cause to symptom
4. **Proof** — the specific log line, DB query result, or isolated reproduction step that confirms causation
5. **Problem** — the generalizable problem class, not just the local failure instance. When the intended fix is a prompt edit, Step 5b must verify this class by trying one level of abstraction deeper.

If you cannot fill in all five, you have not found the root cause yet. Keep investigating.

### Step 5a: Escalate to the deepest owning cause

Steps 1–2 walk _upstream on the data path_ to the first place data goes wrong. That is where the bug is, but it is not always the deepest cause you own. Once you have a proven root cause, interrogate the cause itself: ask "why was this failure even _possible_?" up to three times, treating each answer as a new candidate root cause.

Rules for the ladder:

- **Every rung needs evidence.** Each "why" must be answered with a real, checkable gap — a missing invariant or contract, an absent validation/type, an untested code path, a shared-state assumption — not a speculative story. If you cannot prove the next rung, stop; you have reached the deepest _proven_ cause.
- **Stop when the next "why" leaves what you own.** Halt the moment the next answer would (a) cross into third-party or configuration state you do not control (hand it to the Step 4 classification instead), or (b) name a deliberate, documented design decision. Do not escalate into "the whole architecture is wrong" hand-waving.
- **Fix at the deepest cause you still own.** The repair belongs at the lowest rung that is both in-scope and evidence-backed.
- **Prefer the cause that also kills the siblings.** When two rungs are both in-scope, choose the one whose fix prevents the _other failures you can concretely enumerate_ from the same gap. If you cannot name at least one sibling failure the deeper fix also prevents, you have probably escalated past the real root cause — drop back down a rung.

The deepest owned cause you land on _is_ the **Problem** class from Step 5, and it is what Step 6's generalizable fix should target.

Example:

- **Symptom:** user sees a malformed message.
- **Why 1:** `message_person.py` sent a string the front-end can't render. (upstream on the path — Step 2 stops here)
- **Why 2:** the string was malformed because the LLM response parser accepted a shape it can't safely serialize. _Evidence: parser has no schema check; the log shows the raw shape._
- **Why 3:** the parser accepted it because no boundary validates tool-call output against a contract before it enters the message pipeline. _Evidence: grep shows three other tools feed the same unvalidated path._
- **Why 4** would be "the message pipeline was designed without a validation boundary" — a design decision, and the fix (add the boundary) already lives at Why 3. **Stop.** Fix at Why 3; it also prevents the three sibling tools from producing the same class of malformed message.

For benchmark failures, attach the diagnosis to one of the problem buckets below. If more than one independent issue occurred in the same benchmark run, write one problem entry per issue.

| Problem bucket                                         | Use this when                                                                                                                                                                                                                                                                              | Do NOT use this when                                                                                                                                                                                        | Generalizable fix shape                                                                                                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Timeout too aggressive**                             | The code path is making valid progress, but a benchmark deadline, idle watchdog, provider idle timer, or derived timeout expires before the path can reasonably finish. Evidence must include spans/logs showing continuing useful work or passing runs just beyond the current budget.    | The agent is looping, blocked on missing state, waiting on a never-fired event, stuck behind a resource bottleneck, or failing because data is malformed. "The runner timed out" is only a symptom.         | Fix the timeout policy at the owner layer: derive from pass history/span baselines, split idle vs wall-clock budgets, emit better progress heartbeats, or tune the watchdog condition for the whole class of tasks. |
| **Logical inconsistency in harness prompts/contracts** | The harness gives contradictory instructions, a prompt disagrees with the evaluator, a tool schema conflicts with tool-result formatting, or the runner expects state that another layer intentionally hides. Evidence must cite the conflicting prompt/schema/evaluator/runtime contract. | The prompt is clear but the agent chose poorly, the data fixture is wrong, or the desired behavior requires a capability that does not exist.                                                               | Move the contract to one source of truth and update every consumer: task prompt, tool schema, verifier prompt, context builder, evaluator, and UI/runtime metadata.                                                 |
| **Uncaptured user preference/spec**                    | The user expected a stable product preference or benchmark convention that was not encoded in the task, fixture, evaluator, default prompt, or harness config, so multiple valid behaviors existed and the agent chose the wrong one.                                                      | The requirement was already explicit and the system ignored it, or the user preference requires a new tool/capability before it can be followed.                                                            | Encode the preference at the narrowest stable boundary that all future runs share: task definition, evaluator, harness default, reusable prompt fragment, or product config.                                        |
| **New tool/capability required**                       | The task requires observing or changing state that current tools cannot access reliably or safely, such as a missing domain API, browser/phone/payment primitive, trace query, or data-source-specific operation.                                                                          | An existing tool can do the work but the prompt failed to select it, the tool result was formatted badly, or the fixture omitted required data.                                                             | Add the missing capability at the abstraction that owns it, with a typed schema, clear permissions, evaluator coverage, and representative benchmark coverage.                                                      |
| **Concurrency inefficiency**                           | Correct work becomes slow or flaky because parallel execution amplifies CPU, memory, connection-pool, event-loop, worker-slot, provider-rate-limit, or shared-service contention. Evidence must compare per-unit work with concurrent-run behavior.                                        | A single agent/task is slow for reasons unrelated to load, a provider is down, or the benchmark prompt asks for unnecessary work.                                                                           | Fix scheduling/resource ownership: bounded concurrency, batching, coalescing, per-run isolation, shared expensive sampling, task partitioning, or explicit load-test isolation.                                     |
| **Fixture/environment/data mismatch**                  | The benchmark run used the wrong seed data, stale local/prod DB state, missing env var, wrong public URL, wrong task queue, wrong user/account identity, or a fixture that does not match the task's assertions.                                                                           | The data is correct but the agent lacks instructions/capability, or an external service returned a legitimate error.                                                                                        | Make the fixture declarative and validated before launch: base image, deltas, env checks, URL/task-queue injection, identity mapping, and preflight assertions.                                                     |
| **Observability/trace capture gap**                    | The failure cannot be diagnosed or replayed because the benchmark did not preserve the raw request, spans, tool inputs/outputs, screenshots, active tab state, logs, or evaluator artifacts needed to compare source to sink.                                                              | Evidence exists but was not read, or the fix is only to make logs prettier after the root cause is already proven.                                                                                          | Capture the missing evidence at the source boundary and persist it with the run record so future RCAs can replay the same class of failure.                                                                         |
| **Model intelligence limitation**                      | The exact captured LLM call reproducibly fails on the original model and passes on an upgraded model with all non-model variables held constant. For nondeterministic behavior, repeated trials must show a clear separation.                                                              | The prompt or contract is inconsistent, input/context is missing, a tool capability is absent, the provider errors or times out, any non-model input changed, or the evidence is a single lucky model flip. | Upgrade the minimum capable model or the owned model-selection policy for this class of calls, and preserve the controlled old-model/new-model replay as a permanent regression.                                    |
| **Other**                                              | Only after proving none of the buckets above fits.                                                                                                                                                                                                                                         | Any case that can reasonably fit a specific bucket.                                                                                                                                                         | Name the missing bucket candidate in the RCA so this taxonomy can be tightened later.                                                                                                                               |

The bucket is the **problem**, not the solution. Do not classify "add popup auto-dismiss" as the problem when the general failure is that screenshot/observation support omits active popups. The general fix is to improve the observation channel so every caller sees the popup state; auto-dismiss is a point workaround unless the product requirement is specifically to dismiss that class of popup.

### Step 5b: Abstraction-deepening gate for prompt edits

This gate is mandatory whenever the intended fix is a **prompt edit** (system prompt, tool description, skill, instruction, or any other LLM-visible text). Naming a Problem class is not enough. You must verify that class by trying to go **one level of abstraction deeper**.

The way to avoid overfitting is to try to come up with a **more general solution**, and only accept the current class when that more general solution **fails to be coherent**. A prompt token that names the incident, the benchmark, or one captured miss is overfitting by construction. The prompt edit must eliminate the **class** of the issue — or the **class of class**, or the class of class of class — not the instance.

Climb until the next rung fails:

1. Name the current problem class `C` (the Step 5 Problem / Step 5a deepest owned cause).
2. Form `C+1`: the class of `C`, or a strictly more general formulation of the same failure.
3. Attempt a coherent generalizable fix at `C+1` that would eliminate `C` and the siblings you can name.
4. If `C+1` is coherent — you can fill What / Where / Why / Proof / Problem and state a non-hand-wavy repair — `C` is too specific. Adopt `C+1` as the Problem and repeat.
5. If the more general solution **fails to be coherent** (the next rung leaves what you own, is a design decision you do not control, or collapses into an incoherent grab-bag / "the whole architecture is wrong"), stop. The current class is the deepest coherent one.
6. Only then may you propose a prompt edit, and only if that edit eliminates the class you stopped at. If a non-prompt fix at that class is coherent, do that instead — a prompt edit is not a consolation prize for skipping the climb.

Record in the RCA, before any prompt-edit approval or implementation: the class you stopped at, the **next-deeper class** you tried, and the one-sentence reason the more general solution failed to be coherent. A prompt-edit RCA that omits that failed deeper attempt is not finished.

## Step 6: Design a generalizable fix

Before writing code, ask: "Am I fixing the instance or the class of bug?"

**Point fix (avoid):**

```python
# Bad: special-case for one tool's timeout
if tool_name == "web_search" and "timeout" in error:
    retry()
```

**General fix (prefer):**

```python
# Good: retry-with-backoff for ALL HTTP tool calls
class HttpToolClient:
    def request(self, ...):
        return retry_with_backoff(self._do_request, ...)
```

Prefer fixes that:

- Eliminate the **class** of bug, not just the **instance**. For a prompt edit, Step 5b must already have shown that a more general solution fails to be coherent; otherwise keep climbing (class of class, class of class of class) instead of editing the prompt.
- Respect encapsulation — fix it in the layer that owns the responsibility
- Don't duplicate logic that already exists elsewhere (search the codebase first)
- Don't add new code paths that aren't tested
- Follow existing patterns in the codebase for similar problems

### Step 6a: Prefer the fix that shrinks the subsystem

Before writing the fix, ask explicitly: **can I resolve this bug by reducing the
complexity of the whole subsystem I'm touching, rather than by adding another
branch, guard, flag, or special case to it?**

Repeated RCAs are the primary way a codebase rots. Each one adds a targeted patch;
left unchecked, the subsystem accretes conditionals, dead branches, decoupled
streams that must agree, and order-dependent merges until it is unmanageable and
disorganized — which is itself the soil that grows the next class of bug. A bug is
frequently _evidence that the subsystem is over-complex_, not just that one line is
wrong. When many of your RCAs keep landing in the same subsystem, treat that as a
signal the subsystem needs simplification, not more patches.

For every fix, evaluate in this order and prefer the earliest that fully kills the
class of bug:

1. **Delete** — is there redundant state, a duplicated code path, a decoupled second
   source of truth, or an order-dependent step whose _removal_ makes the bug
   impossible? (e.g. collapse two streams that must agree into one; derive a value
   instead of accumulating it; remove a cache/dedup pre-pass that fights a later
   pass.) Deleting the failure surface is strictly better than guarding it.
2. **Unify** — can the fix consolidate scattered logic to one source of truth so this
   and its sibling failures all disappear? (This is the Step 6 generalizable fix.)
3. **Guard** — only if delete/unify genuinely don't apply, add the narrowest correct
   check.

A fix that adds net complexity to a subsystem that is already generating repeat RCAs
must be justified: state in the RCA why simplification was not possible. "It was
faster to add a branch" is not a justification. Since this repo is pre-launch with no
backwards-compatibility obligations, prefer the invasive simplification over the
compatible patch whenever the simplification removes the bug class outright.

### Step 6b: Check the golden references before choosing the fix

The reference harnesses are heavily tested in production; this repo is not yet.
Before settling on a fix, find how they handle the same problem:
`claude-code-src/` (vendored), `openclaw/`, `hermes-agent/`, and `codex/` (run
`bash scripts/sync-reference-repos.sh` when a clone is missing).

1. Search each repo for the mechanism in question (tool-output limits, retries,
   truncation, prompt wording, loop control, recovery) and open the code. Record
   the `path:line` of every analog you find.
2. State what each one does in a sentence, and what they have in common.
3. Prefer the fix that brings Rose **closer** to that shared pattern. A fix that
   moves away from all of them needs a stated reason their approach does not fit.
4. Put the citations in the case file and in any approval request (the
   `**Golden reference:**` Evidence field in `.claude/shared/approval-format.md`).
   Well-grounded citations let an approval-gated fix clear its human gate
   through that file's Golden-reference adversarial review.

Do this before designing the fix, so the references shape it rather than
decorate it. When no reference repo has an analog, say which repos you searched
and for what. Never cite a reference from memory.

## Step 7: Adversarial RCA review

Before handing any RCA diagnosis back to the user, fire a sub-agent to
adversarially review the diagnosis. The review must check whether the identified
problem lacks precision, depth, proof, or is hand-wavy in any way.

Give the sub-agent:

- The draft RCA.
- The runtime evidence used.
- The proposed root cause and generalizable problem class.
- For a prompt-edit fix: the Step 5b climb (class stopped at, next-deeper class tried, why the more general solution failed to be coherent).
- The fix or next action.

If the sub-agent finds gaps, fix the RCA or gather more evidence before
returning it to the user. Do not present a diagnosis until the adversarial review
has either passed it or its objections have been resolved.

## Step 8: Write the case file

Every RCA ends by writing itself into `docs/rca/cases/` so the next agent
inherits the diagnosis instead of paying for it twice. This is required for every
outcome, not just `fixed` — a blocked RCA with an open observability gap is
exactly the record a future agent needs most.

```bash
python3 scripts/rca_archive.py new <slug-naming-the-cause>   # not the symptom
# fill every section of the generated docs/rca/cases/<date>-<slug>.md
python3 scripts/rca_archive.py reindex
python3 scripts/rca_archive.py validate                      # must exit 0
```

`docs/rca/README.md` carries the full field reference. What determines whether
the case is worth anything later:

- **`symptoms` are the literal strings a future engineer will grep for** — exact
  error text, HTTP status + route, the observed UI behavior. This is the primary
  search surface. Vague symptoms make the case undiscoverable, which is the same
  as not writing it.
- **`first_bad_boundary` and `problem_class` carry the transferable lesson.**
  `problem_class` is the Step 5a bucket — the class, never the instance.
- **`## Human feedback` records what the user corrected, rejected, re-scoped, or
  insisted on**, including approval-time pushback. Write `None recorded.` when
  there was none, and never invent it. This is the section that stops the next
  agent from re-proposing a fix the user already refused; git history records
  what we did, this records what we were told to do differently.
- **`## Reusable lesson` is one imperative sentence.** Search prints it, so it is
  the single line most likely to be read by a future RCA.
- **A recurrence appends to the existing case; it does not fork a new one.**
  Recurrence is the signal that a guardrail failed, and splitting it across two
  files hides that signal.

Set `status` honestly. `open` when the repro gap was never closed, `mitigated`
when the symptom was contained but the cause was not fixed. A dishonest `fixed`
teaches the archive to lie, and a lying archive is worse than an empty one.

`back-end/src/tests/structural/rca-archive.test.ts` enforces the schema, section
completeness, and index freshness on every deploy.

## Anti-patterns (never do these)

1. **"Pre-existing, I'll skip it"** — "Pre-existing" is NEVER an acceptable diagnosis. Just because an error exists in code you didn't touch doesn't mean you aren't responsible for fixing it. This codebase is maintained by multiple agents working in parallel, each of which will naturally produce some amount of uncaught errors. If nobody owns the errors they encounter, the codebase degrades with every commit. You are the immune system — every bug you encounter and walk past is a bug that compounds. If you find it, you fix it. No exceptions.

2. **Defensive fallback** — Wrapping a broken call in try/catch with a default value. This hides the bug and makes it harder to find later. The system should fail loudly when something is wrong.

3. **Symptom patch** — Fixing the downstream effect instead of the upstream cause. Example: reformatting a malformed string in the frontend instead of fixing the backend that produced it.

4. **Speculative handling** — Adding error handling for a failure mode you haven't actually seen or reproduced. If you can't trigger it, you can't verify your fix works either.

5. **Silent degradation** — Catching an error and continuing with partial or wrong data instead of failing loudly. The user and the developer both need to know when something breaks.

6. **Wrong-layer fix** — Adding a workaround in service A for a bug that lives in service B. Even if service A's workaround "fixes" the symptom, the bug in service B will bite again from a different caller.

7. **Correlation-as-causation** — Two things happened near each other in time, so one must have caused the other. Temporal proximity is not proof. Trace the actual data flow.

8. **Archive-as-diagnosis** — Finding a prior case in `docs/rca/cases/` with matching symptoms and reporting its cause as yours. A prior case narrows the search; it is not evidence about _this_ incident. Adopt its boundary only after your own runtime evidence points there, and still produce the repro.

9. **Silent recurrence** — Fixing a bug that a prior case already covered without recording that it came back. A recurrence means a guardrail failed, and that failure is the more valuable diagnosis. Append to the existing case and fix the guardrail.
