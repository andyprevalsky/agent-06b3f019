# WMH build and fundraiser benchmark: local continuation

Archived on 2026-10-15 for the deployment review. The historical run records
below remain unchanged; archival does not mark the fundraising goal complete.
Current status and approval boundaries remain in `WMH_HANDOFF.md`.

Status: WIP continuation on `codex/wmh-experiential-parallel-20261006`, descended
from the October 6 cloud handoff `codex/wmh-handoff-20261006`. This branch
preserves the original source and subsequent diagnostics. It is **not merged
or deployed**. The October 1
`/deploy` of `a4b605f` was a separate change and did not ship this WMH work.
For a checkout from another branch, use the local Git worktree command in
`WMH_HANDOFF.md`. Portable run records and reports are included under
`docs/plans/active/wmh-evidence-20261006/`.

## October 9-10 Linux devbox continuation

`WMH_HANDOFF.md` is the resume point. On a 15.6 GB devbox the native model was
rebuilt in a RAM-bounded systemd scope with swap (13,857 trajectories / 201,546
observations, `grounded-world-model-785e30597233ee43e354`), and the four
five-minute cache conditions were re-measured on identical infrastructure
(provider prompt cache 9.71% / 9.27% / 12.44% / 10.06%; DEMO 0 hits each). Current
main `470925c93` is integrated with full backend, agents and frontend coverage
and every structural gate green. On the merged code the matching v2 conformance
passed (100/100, fidelity 0.8569, content 0.5147) and the unchanged 1800-second
fundraiser failed with $0 settled (provider prompt cache 20.44%, DEMO 0/44); all
durable replays were verified in a fresh browser. Deployment and merge remain held.

## October 8 draft-PR continuation checkpoint

The user requested publishing all WIP changes and continuation instructions.
Read `WMH_HANDOFF.md` first for the current resume point and exact resource
state. Portable evidence is in `../active/wmh-evidence-20261006/cache-optimization-20261008/`.
The original fundraiser acceptance remains unsuccessful; deployment and merge
are held. Current main was fetched at `b1e8a47e3` and still needs careful
integration (209 main-only / 30 branch-only commits before this checkpoint).

The five-minute cache baseline completed: 1,367 cached / 16,341 metered WMH
input tokens (8.365461%), 10,978 output tokens, one cached request of two metered
requests, and DEMO 0/4 lookups with two stores. Two additional native attempts
were cancelled without final provider usage. Both cleanup receipts are clean;
native revision 2 joined, $0 settled, and the durable FE replay was verified
with 20 messages. These totals do not include unknown cancelled usage.

Iteration 1's full-task cache marker is applied and its registered WMH blackbox
passed (89 provider / 37 native checks). Its benchmark was interrupted while
the model loaded, before a root was allocated or the 300-second task window
started; no measured iteration-1 result or clean receipt exists. Stopped owned
Docker containers/volumes and original ownership metadata remain for recovery.
Iterations 2 and 3 are reviewed, unapplied patches. Run iteration 1, then apply
each patch sequentially, promote the history guards with iteration 2, and run
the owning suite plus a fresh-cache 300-second benchmark for each condition.
Preserve all simulation/model/policy inputs and parallelism. Offline estimates
of prefix reuse are not live cache rates. The separate role diagnostic records
two GPT-6.1 Sol xhigh public explanations; it does not prove original hidden
role confusion and changed no runtime prompts.

## October 8 fresh-cache distribution diagnostic

The user's latest authorized run is complete. In isolated worktree
`rose-wmh-experiential-parallel`, branch
`codex/wmh-experiential-parallel-20261006`, the unchanged fundraiser ran with
the explicit 1800-second timeout, a fresh goal-scoped DEMO cache, and
GPT-6.1 Sol xhigh as the WMH model. Root/general-purpose model defaults,
task prompt, price cap, evaluators, initial company facts and warm-network
environment were unchanged. The new immutable local
`rose-outcome-distribution-v2` policy activates the previously tested
probability-justification, approval-assumption and public-evidence/omission
instructions; this is not a deployment or full conformance qualification.

Run `bbbdb300-bde5-4386-8463-cbef0cba9319`, root
`f8065e19-2fc5-4557-82a8-62dfadde5382`, failed: the harness observed
`Timeout after 1842s (dynamic cap=1800s)`. Reported task duration including
fixture setup is 1972.5 seconds. The joined native retirement at revision 15
confirms $0 settled proceeds, no commitments, signed instruments, pending
wires or incoming Brex transfers. One internal email was simulated as sent
after correcting the sender identity. No investor-form submission occurred.
There were 75 native prediction attempts for 20 invocations and 15 committed
transitions, with state rebases reaching six retries and actual provider /
internal deadline errors. Proposal records are not commit evidence.

Final WMH DEMO response-cache hit rate: **0/75 (0%)**, with 68 stored responses
and no cache lookup failures. WMH provider prompt-cache reads:
**0/1,813,251 input tokens (0%)**. The agent-tree cache metric of 40% measures
different model calls and must not be substituted for either WMH rate.

Benchmark and stack cleanup receipts are clean; the exact WMH session joined,
the four-agent tree sealed/deleted, recorded serving processes retired, and
the owned Docker container and volume are absent. The initial archive warning
was resolved by publishing the frozen run bundle through
`scripts/publish_evidence_links.py`; the share link rendered and reloaded in
a fresh browser with 34 root messages. This verifies the cutoff transcript,
not a successful fundraiser or completion of pending archived tool cards.
The verified share-link manifest and independent final audit are under
`.context/wmh-fundraiser-distribution-20261008/`; see `final-run-review.json`
and `published/f8065e19-2fc5-4557-82a8-62dfadde5382/manifest.json`.
The exact benchmark JSON is
`agents/benchmarks/runs/20261008_035456_bbbdb300-bde5-4386-8463-cbef0cba9319_raise-5m-rose-labs-brex.json`.
Portable outcome, cache, cleanup, exact Browser goals and verified share-link
receipts are in `../active/wmh-evidence-20261006/wmh-fundraiser-distribution-20261008.json`.
Owning checks passed before execution: provider/pricing 88, native 37, and
Ruff. Fresh full conformance, the broader fundraiser goal and the deferred
nonzero warm-network environment remain open. Deployment remains held.

## October 8 WMH provider-prefix cache correction

The user requested a real prefix-cache hit test through Rose.complete. Six
live GPT-6.1 Sol xhigh calls used two saved fundraiser inputs with DEMO replay
disabled, unchanged logical evidence and the same 16384-token output budget.
Original requests returned 0/2 hits. Moving shared task context first and
passing session affinity also returned 0/2. With an explicit reusable-task
text-block breakpoint, the cold request read zero and the warm request read
**1368/13429 input tokens (10.187%)**. Final fixed-pair provider hit rate is
**1/2 requests**, or **1368/15633 input tokens (8.7507%)**. No retry ran.

The native adapter now supplies Rose's existing stable session namespace and
marked shared prefix; complete task/action/state/retrieval values and system
instructions remain intact. WMH-only replay keys ignore that routing hint
while retaining exact call IDs, state and execution-policy identity. This
uses existing central Rose cache controls. The full owning gate also exposed
colliding inferred timestamps reversing recovered corpus results; its existing
test now freezes archive milliseconds, and inferred timestamps remain
monotonic per producing agent. Authoritative tool/browser timestamps are
untouched. All changes remain local. No fundraiser rerun or deployment ran.

Portable live receipts and limitations are in
`../active/wmh-evidence-20261006/wmh-provider-prefix-cache-20261008.json`; causal controls
and owning-gate logs are in `.context/wmh-provider-prefix-cache-20261008/`.
The affinity recurrence is recorded in
`docs/rca/cases/2026-07-23-provider-cache-affinity-not-scoped-to-one-sequence.md`.
Fresh full conformance, fundraiser acceptance and warm-network changes remain
open. These two cache mechanisms must be reported separately on the next run.
The full registered WMH blackbox passed, including provider 89/native 37 and
both corpus-ordering guards. Pricing 7, Ruff, diff checks, independent wire
audit, adversarial review and RCA archive validation also passed.

## October 6 user screenshot follow-up

The authorized local 30-minute run `22da47fc-6ac7-4ab2-8cb7-ac2a3ca57b5f`
finished with one failure, zero passes, `Timeout after 1801s`, and $0.99
reported inference cost. No $5 million receipt or production deployment was
established. The inspection transcript is not benchmark acceptance evidence.

The user then authorized fixing the malformed code completion and requested
an actual-trace contact diagnosis without preemptive prediction changes.
The code-card producer and legacy replay path are fixed locally, with permanent
owning agent/UI regressions, all FE coverage passing, and a local browser
loading the archived API response and showing one completed expandable chip.
The production frontend has not received this fix yet.

The complete WMH session/retrieval trace was captured. Exact screenshot
reconstruction reproduces its negative on the original GPT model/provider.
Successful unrelated retrieved examples contradict the all-error-samples
explanation. A controlled Precursor replay gives 3/3 false negatives on the
original input and 3/3 correct official `/startup.html` routes after adding
only independently fetched first-party page data. Removing the prospect list
or error demo does not resolve it; simplifying the goal guesses an unverified
URL. This establishes a target-resource grounding gap for that lookup, not a
passing fundraiser or proof that every firm has a public pitch channel.
Other recognized forms still require unknown Rose company/product facts.
See the October 6 code-lifecycle and contact-resource RCA cases and the portable
replay receipt in `../active/wmh-evidence-20261006/contact-replay-diagnosis.json`.
Prediction behavior, model/corpus selection, benchmark assertions, timeout,
and production remain unchanged in this follow-up. The contact/fundraiser
RCA remains open until a general repair and exact outcome verification pass.

The user subsequently clarified that plausible synthetic forms are expected;
unknown Rose company facts are acceptable blockers. Actual website records
are therefore not a prerequisite. Exact recorded Precursor and Founders Fund
browser goals are included in the new diagnostic evidence. Original Sol and
GPT-6.1 Sol each return 0/6 public routes under the original browser inputs.
An explicit open-world simulation-policy control lets Sol produce forms;
recorded context still suppresses some results. For Founders, original policy
with cleared history/notes stays negative (both models 0/3); open-world policy
with recorded context stays negative (0/3); the same open-world policy with
history/notes cleared yields 3/3 plausible submitted inquiries, retaining $0
funding. This isolates policy/context interaction and demonstrates existing
Sol capability, without isolating a single prior sentence or proving a
production repair. All 57 valid diagnostic trials and exact goal/policy text
are in the portable evidence directory. The production prompt, model, seed,
corpus and benchmark remain unchanged in this diagnostic follow-up.

## Goal and user decisions

October 6 local continuation uses the isolated worktree
`/Users/andyprevalsky/Developer/rose-wmh-continuation`, branch
`codex/wmh-continuation-20261006`. Main `8ed0c776d` and portable handoff
`e5e0ff622` are integrated. The complete uncapped local rebuild finished on October 6: 12,519 real
trajectories and 179,169 eligible tool observations. Corpus structural sampling
passed all 100 examples across 47 tools and 10 categories. All 97 export
failures are explicitly recorded ciphertext checksum mismatches and remain
unresolved exclusions. Matching live inference conformance remains pending.

October 6 local verification: backend coverage passed all 184 blackbox domains
and 253 unit files, with 89.23% lines / 80.34% branches. Codex sandbox auth uses
an isolated test identity with the current authoritative auth file; no shared
integration was removed. Five cold seed-fidelity runs passed at 168–171MB,
under the unchanged 228MB bound. Full agent coverage subsequently passed all 109 blackbox domains,
181 Fast Cache tests, and 131 unit tests with 82% total coverage. Earlier
fixture failures and timeout observations remain recorded; no bounds were
relaxed. A controller mock's early stdin close has an owning red/green proof
and permanent stress regression; full controller validation remains pending.

The first exact fundraiser startup failed before agent creation because full
build persistence reintroduced Unicode JSONL separators. The native full-build
blackbox has unchanged red/green proof; full artifact normalization validates
179,449 index rows against the embedding matrix and escapes 13 records without
changing decoded content. The exact authorized run has been restarted; no new
fundraising or production outcome is established yet. See the October 6
full-build JSONL framing RCA.

The new diagnostic run is `22da47fc-6ac7-4ab2-8cb7-ac2a3ca57b5f`, root
`67885bdc-fd0f-4023-aa65-d3687df7f2ec`, in isolated context
`.context/benchmarks/1791316596-41932-98492`. Its production shared FE transcript
was independently rendered and reloaded in a fresh browser; a session-owned
updater publishes live transcript snapshots. This is inspection evidence, not
terminal replay or benchmark acceptance. A subsequent full native-index audit
found 280 empty rows caused by overlapping projected timestamps. The native
adapter owning repro has unchanged red/green proof; schema-11 export reserves
disjoint causal intervals and keeps recorded timestamps in canonical payloads.
The corrected complete index is ready under `.context/world-model-grounded`:
12,519 trajectories, exactly 179,169 indexed observations, and zero empty rows.
Every action, observation, before-state, scratchpad, error flag, and ordering
was compared with the complete original source corpus; the matrix is exactly
(179169, 512). Build and full-audit receipts are inside that directory.
The running diagnostic retains its original in-memory index. Future inference
conformance and exact reruns must use `WMH_BUILD_DIR` pointing to the corrected
directory, with `BENCHMARK_SKIP_WMH_DELTA=1` for the exact prebuilt artifact. See the October 6 OTel clock-interval RCA. Its server has also
reported SSL bad-record-MAC errors on some predictions; these remain an open
transport investigation, not a proven configuration or provider diagnosis.

Open operational TODO: cancellation of the first coverage stage after ENOSPC
left its bash controller holding the stdout pipe after npm exited. The exact
owned controller was terminated and cleanup finished. `run_deploy_stage.py`
currently skips signal forwarding when its direct child has exited; whether
that explains the retained descendant is unproved. Preserve this as an open
ownership/observability issue, reproduce with a direct child that exits while
its descendant retains stdout, then verify bounded cleanup without signaling
unowned processes. Do not report it as fixed.

Build the World Model Harness (also called WHM in the conversation) from real
archived tool results and make its simulation useful for the
`raise-5m-rose-labs-brex` benchmark. A valid run must show actual simulated
investor/lender commitments and at least $5 million arriving in the simulated
Brex account, grounded in tool observations. No real investor outreach or money
movement should occur in simulate mode.

- Root and general-purpose agent loops, including `for_each`, stay real. WMH
  supplies specialized explore/browser/code results and external environment
  boundaries. Browser simulation happens at the whole tool-call boundary.
- Corpus inputs must be real completed observations. Exclude DEMO and simulated
  trajectories before indexing; real non-DEMO benchmark trajectories are valid.
  Include completed steps from active runs, even before their final fixture is
  written. Do not impose an arbitrary 100-bundle cap. Pair agent-scoped calls
  with their latest terminal result and preserve per-action browser transitions.
- The synthetic fundraiser starting state says services are connected by
  default (including Brex browser access, Gmail `tamara@roselabs.ai`, and Tamy's
  SMS identity). Connectivity does not imply prior correspondence, investor
  interest, commitments, or deposits. WMH must return production-shaped results
  without inventing those facts.
- Use `rose-ultra` for the benchmark and `rose-1-ultra` for WMH predictions, as
  currently configured. DEMO-enabled WMH calls may write their own DEMO cache
  keys; clear the fundraiser's DEMO cache before comparative reruns and inspect
  hit/write metrics. Keep provider credentials out of persisted cache entries.
- The user authorized a **30-minute diagnostic run** after the 10-minute runs
  stalled. The catalog still declares 600 seconds; use the per-run
  `--timeout-seconds 1800` override for that diagnostic. Do not weaken the
  evaluator or silently extend the catalog limit. Earlier instructions saying
  to preserve a 600-second cap for every run were mistaken.
- Keep changes scoped to WMH and its benchmark path. Do not alter prompts or
  unrelated harness behavior to force a passing trajectory. Same-session WMH
  LLM predictions must overlap; retain the blackbox assertion for this.

## Snapshot and evidence

- Source snapshot starts at `a58f662a6` plus all dirty `porto-novo` files. On
  2026-10-06, `origin/main` was `33d2171e8` (327 commits ahead of that base).
  Integrate upstream carefully after preserving this checkpoint. No fresh full
  test suite or deploy gate was run for this WIP snapshot.
- Key code: `agents/benchmarks/world_model_harness.py` (archive selection,
  projection, conformance, model build), `serve_world_model.py` (retrieval,
  root session, parallel inference), `wmh_rose_provider.py` (Rose provider and
  DEMO cache), `run_benchmark.py`/`local.py` (simulation and reporting),
  `agents/helpers/world_model_runtime.py`, and
  `agents/benchmarks/tasks.json` (fundraiser contract).
- The generated model artifact `.context/world-model/` is about 1.7 GB and its
  binary index is **not on this Git branch**. The exact run records, corpus
  conformance, delta index, audits, and small model metadata are included as
  portable evidence files. The September 28 corpus conformance report passed:
  100 sampled examples, 7,264 trajectories, 10 categories, 42 tool names,
  103,519 eligible examples. The saved prediction score in `.context/` is from
  an older build; it does not validate this artifact or a new local rebuild.
- The September 28 10-minute simulated run
  `20260928_213636_raise-5m-rose-labs-brex` timed out with zero outreach and
  zero approvals. First-wave WMH browser predictions reported no verified
  submission/contact route. These are predictions, not proof about real sites.
- The September 29 **30-minute diagnostic** run
  `20260929_024443_raise-5m-rose-labs-brex` (root agent
  `89cb4dfb-551e-4dd5-a92c-94182274ef77`) completed after 22m27s but
  failed: $0 raised, no investor messages or applications, no commitments, and
  no Brex deposit. After an outreach child returned success with zero sends,
  the root moved to commitments and made 60 simulated daily funding checks.
  The completion verifier showed 100% progress despite the unmet goal. The
  recorded failure reason, `Expected approval requests but none were
  triggered`, reflects that no outbound action was attempted; investigate
  agent trajectory, WMH predictions, and evaluator separately.
- The user reported that the published Rose FE link for that run showed
  nothing: `https://www.roselabs.ai/?agent-id=89cb4dfb-551e-4dd5-a92c-94182274ef77`.
  This branch contains an archive-index lookup fix in
  `back-end/src/providers/benchmarkHubLookup.ts`, but it has not been deployed
  or verified for the user's viewing context. HTTP 200 or an admin-only view
  does not establish that the user can open the replay.

## Known boundaries to verify

- Same-session inference now snapshots under a short lock, predicts outside
  the lock, and commits under the lock; the Rose bridge shares one async loop
  so Fast Cache futures complete. Blackbox tests cover overlap and retained
  steps. The unchanged fundraiser still failed after these fixes. See
  `docs/rca/cases/2026-09-28-wmh-root-session-send-email-head-of-line-wait.md`.
- The provider now rejects blank or token-truncated WMH completions before a
  successful step is committed; the served boundary has a regression test.
  Recheck this against live model output. The related RCA remains open because
  the full benchmark has not passed:
  `docs/rca/cases/2026-09-28-wmh-blank-prediction-became-successful-explore-result.md`.
- Root goal and initial fixture hydration, and retention of the last good WMH
  usage/retrieval audit, have focused regressions. Their RCAs remain open
  pending an end-to-end passing run. Review the other WMH cases in
  `docs/rca/cases/` before changing routing or evidence capture.
- Earlier traces also contained a JSON-looking string where
  `spawn_general_purpose_agent_for_each.items` required an array, plus a
  browser result exposed as a nested `output` envelope. Determine whether
  either recurs; do not treat them as the cause of the no-outreach outcome
  without a reproducing trace.

## Continuation sequence

October 6 native architecture continuation: work is isolated in
`~/Developer/rose-wmh-experiential-parallel`, branch
`codex/wmh-experiential-parallel-20261006`. Current main `fda5cc0e7` was
integrated at `a1142bc14`. The native path pins Experiential `0.7.158` at
`bf75987eac5e8c984d8f3868249f84e4095d1733` and uses its actual v3 request
builder/parser, immutable dataset/RAG/model artifacts, lineage exclusion and
context packing. Python 3.12 runs separately from Rose's Python 3.11 provider:
the complete manifests conflict on anyio, so an authenticated loopback bridge
retains existing credential leasing and pool routing without changing either
dependency contract. Select it explicitly with `WMH_ENGINE=experiential`.

Same-world predictions still overlap. Atomic commits compare the whole state
revision and re-predict stale calls; disjoint writes alone cannot establish
independence when both calls read a shared balance. Eight overlapping calls
retain eight effects, with up to 36 predictions in the worst-case fixture.
This is an eight-call boundary proof, not a 10,000-agent capacity result.
Invocation receipts survive caller disconnects and deduplicate retries;
failed operations release their receipts, and the parent joins its exact
native child during shutdown. Generated predictions remain outside fit data.

The WMH blackbox gate returned `all_passed: True` with 27 native checks
and 52 provider checks. The focused serving/provider/initial-state suites
passed 60 tests. New evaluator tests first failed for exact canonical receipts,
then passed with protocol-neutral decoding and unchanged fidelity thresholds.
The caller retains its prior result shape. Native suites now record exact
source transition IDs in `conformance.native.json` and require the served
artifact ID and manifest digest to match before any live predictions. Legacy
suites remain compatible. Native traces retain full root and delegated goals,
returned responses, and typed failures with timing; a response rejected inside
the provider is not falsely reported as captured. Unchanged archive updates
validate/rebind the existing artifact rather than reconstructing the corpus;
changed builds retain upstream embedding checkpoints. Scoped artifact loading
reads each immutable artifact once while retaining public typed/provenance
validation; fresh loads revalidate storage and release the verified bytes on
success or failure. The owning test first reproduced 3/4/4 whole-artifact
reads, then passed at 1/1/1. Startup-only GC suppression preserves all public
validators, releases the verified byte snapshot, and restores the caller's GC
state on success and failure. Native
cache keys retain exact call IDs and state/history clocks while ignoring only
the current candidate envelope timestamp; the real-key UUID collision has an
owning red/green regression.

The full native import reached 179,150 observations, excluding nine explicit
DEMO-fixture trajectories (19 observations) from the original 179,169-pair
local snapshot. The immutable dataset, RAG and model are published; all 100
original conformance cases bind to exact native source transitions. Full loading
and binding took 241.62 seconds with a 38.74 GB peak footprint. The actual native
service then missed the unchanged 180-second startup bound and its owned parent
and child retired cleanly. A public-API-only ASCII JSONL republication passed 27 native checks and the complete
owning WMH blackbox, preserving decoded records, vectors, raw source identities,
model/prompt settings and the original immutable artifacts. The full conversion passed official validation, exact ordered record/vector
comparison and all 100 conformance bindings. The new serving artifact is
`grounded-world-model-a41208d8c48f810b60d1`, manifest
`ba1d5bd5c061a57615f9a6a7bfe7154923128d95db7216f8f524e60d613e2b6b`.
Conversion took 1,688.83 seconds (including original Unicode validation),
with a 38.92 GB peak footprint. Cold service startup passed in 172.24 seconds
under the unchanged 180-second bound; its health identity matches the bound
100-case suite. The first live prediction conformance run at concurrency eight
scored 0.84828 mean fidelity and 0.59140 content accuracy, above the unchanged
0.70/0.25 floors, but failed the 100-success requirement with 99 successful
calls. Case 83 encountered a raw TLS record-read error before response headers;
it escaped the provider's pre-output fallback classifier and became HTTP 500.
The owning real-HTTP-context test reproduces that error and passes after adding
`ssl.SSLError` to the shared pre-output classifier. Its streaming inverse keeps
the exact error after partial output without replay. Independent review approved
this small fix; the underlying TLS record failure remains unexplained. Fresh
cold startup passed in 161.72 seconds and the full 100-case rerun passed with
zero prediction errors, mean fidelity 0.87569 and content accuracy 0.61843.
Score variation between runs is not attributed causally to the TLS fix.
Live same-world concurrency also passed using four unchanged archived actions:
four overlapping provider calls, three stale-state rebases, four unique commits,
and two exact duplicate receipts, with own-lineage exclusion and at most five
unique retrieved traces. The proof's session retired cleanly. This does not
qualify eight-way or 10k concurrent live execution. Benchmark, viewer and
production acceptance remain unproven.
Native launch settings now survive cloud boot, SSH and refresh, build/serve
pools agree, and setup supports both GNU and macOS checksum tools; their owning
red/green fixtures passed. Full cloud native runtime provisioning, authenticated
installation, artifact transfer and memory/startup acceptance remain unqualified.
The local workspace-env suite also passed after its hermetic fixture resolved
the host timeout executable before clearing PATH, preserving the 60-second bound.
Preliminary backend coverage passed 186 blackbox domains and 255 unit files;
frontend and agents coverage passed. The live credential and Amplitude gates
passed. The unchanged chat-router failover gate subsequently passed in 7.555
seconds on one Modal response with the exact original request. The historical
Morph timeout remains evidence of output/provider variability, without proving
a causal schema fix. Its separate schema proposal is unapplied. Test-only hooks
now preserve actual run/transcript/HTTPS dump evidence before fixture cleanup.
All seven owned processes and local fixture rows were removed; the isolated
database remains. Final frozen-source deploy gates remain required.

The 97 remote checksum exclusions remain an open corpus gap. A bounded audit
verified their manifests and reproduced a current two-PUT ciphertext/metadata
publisher race at the real S3 command boundary. This does not establish that the
same schedule caused every historical failure or recover their starting fixtures.
Repair alternatives and exact probes are in `remote-checksum-exclusion-review.json`.
The latest exact native fundraiser run is
`f5e4f83d-386a-4af1-84f5-7745216b6f27`, root
`29064cc2-3266-4605-8e63-eda79e48a0cc`, on `b0c4d185a`. It failed at the
authorized 1,800-second diagnostic limit with $0 raised. Its saved report
listed $16.215 WMH cost and $0.85 task cost. Native predictions continued
after root pause and archive: existing completed-provider logs total
$19.376132 over 334 calls. That is logged usage priced by the existing
accumulator, not an invoice or complete accounting of failed partial streams.
The final observed session snapshot was revision 50; later request snapshots
prove further activity, but no final post-shutdown state receipt exists.
All resources owned by this run have now retired. The portable exact-run hash,
late commits, usage cutoffs and cleanup audit are in
`../active/wmh-evidence-20261006/native-fundraiser-timeout-cleanup-review.json`.

Actual Chrome inspection opened the durable root transcript and all eight
children, expanded browser results, and verified the clean simulated Claude
Code completion row. Interrupted child rows remain visibly unfinished. This
is verified transcript replay; simulate mode allocated no browser/code film
session. The viewer receipt and durable link are in
`../active/wmh-evidence-20261006/native-fundraiser-viewer-review.json`. Approval evidence
separately selects the latest LLM call across the entire root/child tree;
the original publisher manifest selected a root-only dump.

The native system prompt still suppresses forms in the exact captured
Conviction call. A diagnostic-only six-paragraph public-world policy append,
holding the full 210,974-character input and actual `openai/gpt-6-sol` route
constant, produced 3/3 virtual inquiries versus 0/3 on the original system.
All six responses passed the native parser and retained $0 funding, empty
commitments/instruments/wires, existing company facts and pending approvals.
Credentials were deliberately held on the original funded route in both
arms; this does not reproduce normal leased routing. See
`../active/wmh-evidence-20261006/native-form-policy-controlled-review.json`.
The user subsequently authorized local prompt changes without a separate approval until deployment. The exact reviewed policy was applied locally on October 7; deployment remains explicitly on hold.
Six candidate-only negative controls also passed: two explicit observed
pages with no route, two forms requiring unknown legal facts, and two
recorded HTTP 503 attempts with no persisted effect. All used the same funded
model and retained private facts, approvals and zero funds. Their measured
call span was 50.129 seconds and metering was $0.271156. One initial analyzer
scope mismatch was corrected to allow the explicitly observed form POST URL;
its failed audit is preserved and no model responses were edited or retried.
See `../active/wmh-evidence-20261006/native-form-policy-negative-review.json`.
These single-call controls do not establish fundraiser acceptance.

Current main `a3585a7bd` was integrated at `f647c1c8b`. Focused Google-source,
grep-budget, backend TypeScript and cloud-init tests passed. Native retirement
now has owning red/green proofs that join actual provider cleanup before
freezing state and usage, fence stale root retries, preserve lost-response
deduplication and retain parallel inference. Benchmark retirement integration
passed 79 owning cleanup/wall-clock tests, plus 22 initial-state/cost tests
and the actual HTTP client receipt regression. Simultaneous executions of
one cached catalog task now own separate root/session metadata. Failed joins
produce durable ERROR results with explicitly unsettled cost, retain the
original error, and still attempt independent exact-root cleanup. The original
failed fundraiser report remains unchanged; a new live run must prove joined
retirement at the actual timeout. Final frozen-source deploy checks remain
required.
The broader normal test runner exposed five outdated controller fixtures.
Their unchanged owning cases first reproduced the failures; test-only repairs
passed seven configurations, independently repeated in 4.29 seconds. Actual
controller code, bounds, registry safety and existing worker/absence assertions
remain unchanged. This focused result does not erase the broader failed run
or qualify the final deploy snapshot.
The complete compact benchmark live-results selection then passed 273 cases
in 109.61 seconds. The status-service shutdown fixture now dispatches from
Mac to the existing verified Linux container, preserving actual `/proc`
ownership checks and the original Linux fixture body; its full owning suite
and 16 dispatcher controls passed, with both owned containers exported and
retired. A separate terminal-capacity fixture now follows current main's
intentional settlement of unused demand, while keeping pending-work and
malformed-capacity failure controls and preserving a failed child's exit code.
These are test infrastructure/fixture repairs, not changes to fleet runtime
or benchmark outcome criteria.

The October 7 user instruction authorizes local implementation of the exact six-paragraph addition
and its selection/system assembly in the reviewed candidate patch SHA256
`930865b2738b3344b452a6e7258109686eb17bc373e2f43b30378b7693fd3218`.
Its independent review cleared request preservation, versioned identity,
cache parity and unchanged policy-text hashes. Full native conformance and
fundraiser acceptance must be repeated on the locally applied policy. The new
policy does not inherit the earlier baseline's 100-case pass.

A later evidence refresh saw production Hub upload HTTP 500 and visibility
read HTTP 503. Read-only Render logs traced both to AWS S3 SDK `InternalError`,
while exact SQL lock queries succeeded. The existing run subsequently verified
through the registered publisher, all nine root/child views returned 200,
and the actual latest Lux dump returned 200. No production restart, source or
environment change was made. This was an observed transient storage fault for
these requests; it does not prove a global outage or loss of the saved run.
No production rollout has occurred. The model remains gitignored and must be
rebuilt locally; full native cloud provisioning remains unqualified.


Local application verification (October 7): native31/provider59 owning checks,
24 backend cache controls, the registered WMH blackbox, and102 focused benchmark
retirement/cost controls passed. The first policy-bound100-case live suite
failed99/100: mean fidelity0.8518956 and content accuracy0.589478 meet unchanged
aggregate floors, but one raw TLS exception escaped the existing waterfall
connect/read classifier before response headers. This is a transport failure,
not a modeled rejection. The failed report is retained. All100 exact sessions
produced joined retirement receipts and both serving processes retired. A
minimal raw-SSL classifier correction reproduced3 owning failures and made
those same3 controls pass, including no replay after partial output. The fresh
policy-bound full100-case run passed with100 successful predictions, mean
fidelity0.8609352 and content accuracy0.5846759 against unchanged thresholds.
Independent official parsing/rescoring matched all100 cases. One existing
protocol repair produced101 total attempts; all100 exact sessions joined and
retired. This open-loop result does not establish fundraiser success or unknown
Rose-fact preservation. The unchanged1800-second fundraiser is now running as
`3730e4ca-2226-48bf-8434-78d56092b593`, root
`1670690f-5245-4815-be93-fc15e1426629`, native session
`7e7dd8b00d844bf9bade46b51e49269d`, source`64f856257`. The diagnostic
was interrupted after583.5 seconds when revision3 fabricated prior private
investor correspondence and conditional interest absent from the complete
request, state, history and all five retrieved examples. It generated no
investor-form submission. All owned resources retired; the frozen revision6
receipt confirms joined retirement and process usage$0.73468/10 calls. This is
not a full1800-second acceptance run or a passing fundraiser. The new local
v2 policy preserves the six public-affordance paragraphs and adds a private
history/unknown-company guard while allowing new causally subsequent replies.
Ten same-model saved-request controls were independently reviewed: v1
private-history fabrication1/2 versus v2 0/2; v2 simple public forms submitted2/2;
unknown-required-field forms blocked2/2. Both causal-reply cases returned
legitimate no reply, so positive future-response capability remains inconclusive.
Native32/provider66/backend24/Python-cache7/cloud-config-and-launch11 owning
checks pass, with150 old cache keys byte-identical. Fresh matching full
conformance and clean fundraiser acceptance remain pending. See
`../active/wmh-evidence-20261006/native-policy-v2-local-review.json`.
Deployment is held.
See `../active/wmh-evidence-20261006/native-policy-first-conformance-review.json` and
`../active/wmh-evidence-20261006/native-policy-conformance-qualification.json`.

1. Read `CLAUDE.md`, `docs/testing.md`, and
   `agents/benchmarks/README.md` (World-model refresh conformance). Set up the
   local Mac environment using repo guidance. Do not use the Linux cloud-init
   command on the Mac.
2. Run focused tests: `agents/benchmarks/serve_world_model_test.py`,
   `wmh_rose_provider_test.py`, `run_benchmark_wmh_initial_state_test.py`,
   and `agents/tests/blackbox/world_model_harness.blackbox.py`. Preserve the
   parallelism and invalid-completion regressions. Then run the affected
   backend, agent, and deploy structural gates before proposing a merge.
3. Build/refresh WMH from the complete eligible archive and inspect the
   coverage/selection report. The cloud maintenance entrypoint, if used, is
   `bash scripts/run-bench-cloud --refresh-wmh --ref <pushed-commit>`; it fetches
   a commit, so new builder edits must be pushed first. Local builds use
   `update_world_model_for_simulation()` and the configured R2 credentials.
4. Serve the resulting model and run
   `python -m benchmarks.run_world_model_conformance` against its *matching*
   `conformance.json`. Require 100 successful calls, mean fidelity at least
   0.70, and mean content accuracy at least 0.25. Inspect category failures
   and exact retrieved real-world examples, not just aggregate score.
5. Clear the fundraiser's DEMO cache, then run the unchanged task in simulate
   mode with the authorized one-off override:
   `BENCHMARK_SKIP_WMH_DELTA=1 bash scripts/run-bench --local raise-5m-rose-labs-brex --simulate --timeout-seconds 1800`.
   Validate that the root/general-purpose agents remain real, external actions
   remain simulated, WMH cache writes/hits work, and the final $5 million claim
   traces to concrete simulated commitments and Brex deposits.
6. Repair and independently verify the Rose FE replay in the viewing context
   the user actually uses. Publish a durable run link and verify rendered
   messages; do not claim success from an admin-only view.
7. Deployment is currently held by explicit user instruction. When the user resumes deployment and the benchmark and affected tests pass, use the repo's `/deploy`
   workflow for review, merge, production rollout, and post-deploy gates. Keep
   the final report explicit about the commit, model artifact, corpus coverage,
   inference scores, benchmark outcome, FE replay, and production state.
