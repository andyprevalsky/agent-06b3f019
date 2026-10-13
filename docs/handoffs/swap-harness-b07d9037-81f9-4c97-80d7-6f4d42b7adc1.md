# WHM original-filesystem preservation

This is the old-filesystem checkpoint for draft PR #1453. Source preservation
is complete for the two WHM worktrees and the inspected local helpers/variants.
Private evidence capture and independent NEW verification/meaningful continuation
are complete. Own OLD archival request is the final pending operation. Run12 finished
with a task timeout failure and clean benchmark/stack/WMH shutdown.
The migration awaits managed OLD archival acceptance and coordinator disposition.

## Goal, authority and boundaries

Original user goal: continue the realistic `raise-5m-rose-labs-brex` trajectory,
retain prediction quality, native parallelism, shared world state, sample-once
outcomes, canonical evidence and replay identity. The latest user instruction
was: "Tamy just finished connnecting her messaging clients on prod, make sure
to include those in our base fixture and thus our starting state for this
benchmark, then rerun w DEMO cache cleared for 60 min".

After each run report total/cached input, output, cache percentage, DEMO
hits/lookups/stores, trajectory narrative and completion percentage, verified
durable FE replay, then multiple-choice next decisions. Research-based
distributions are soft examples, not enforced outcomes. Preserve the approved
world-clock V1–V12 contract and the whole-history messaging fixture.

**Do not merge or deploy. Preserve Freedom and every protected instruction.**
Migration does not authorize another paid run or changed acceptance rules.
Skip Browser Mode P2 entirely. Boxes whose main work already belongs to Codex
are excluded; this old box's main task is stalled Claude work, and its current
Codex thread is only the preservation helper. The original task source was frozen through run12 execution; this checkpoint
is written in a separate worktree.

## Identities and prior context

- Old devbox: `b07d9037-81f9-4c97-80d7-6f4d42b7adc1`, established from ordinary
  managed daemon launch configuration `controlAuth.instanceId`; provider sandbox
  `ilfeo8lxdc81flywi5kq6` is not the devbox routing ID.
- Original Claude session: `4f2f012f-6f90-478e-8068-2b9474d4e5da`;
  [original thread](https://boxes.dev/thread/thr_8b123724f677458da61d5e215786a405),
  internal `ph7dvh51k0atw7myrk0jk1bynx8fy2kj`.
- Latest original replies repeatedly report "You've hit your session limit ·
  resets 12:40am (UTC)"; the exact local JSONL confirms the quota stop.
- Preservation helper native Codex session:
  `01a13276-117e-7c92-baea-06fa5e6d2cfd`.
- [Draft PR1453](https://github.com/Rose-Ai-Labs/rose/pull/1453), branch
  `codex/wmh-experiential-parallel-20261006`; preparation HEAD
  `ed4fbc863cc2f9162da37934935b3da347c71949`.
- Previous replacement `09712616-018b-454a-bbf2-d38ff23dd1e5`, thread
  `ph7c227aym08mq92ryd0pajzs18g5gtq`, is archived. The coordinator's supported
  reuse probe returned nonretryable `target_not_found`. Its historical partial
  receipt is not a full-checkpoint continuation receipt. Never route to a Template.
- The full-checkpoint old-box start key
  `swap-harness-whm-20261012-full-checkpoint-replacement` and its authorized
  generation2 both failed before placement. The verified root-owned replacement
  and actual successful key are recorded below; no further starts are needed.

Read the existing thread-based harness handoff, current `WMH_HANDOFF.md`, active
WMH continuation plan and `.claude/skills/instantiate-whm/SKILL.md`. October12
continuation supersedes old October8 integration/cache instructions. Run11
reported 92.7% cached input and 0.138× input cost; that is a historical
measurement, not run12's result.

## Exact source inventory

- `/home/boxes/rose`: clean tracked `main` at
  `470925c932fa5813e496df6f61c6c07e7879d36c`.
- `/home/boxes/rose-wmh-resume`: clean tracked `wmh-resume` at
  `18136e6e0faeaca0bd99847733ada7da50930bd8`, ancestor of PR1453.
- `/home/boxes/rose-wmh-merge`: clean tracked `wmh-resume-merge` at
  `39a0433b8850f38996c7fb1433c043998b6f9eeb`, ancestor of PR1453. The only
  subsequent remote differences before this checkpoint were migration documents.
- No staged/unstaged task source or deletions were found in either WHM worktree.
- Four local experiment commits were absent from all origin refs. Their exact
  Git commits and blobs are in `whm-b07d9037-preservation/original-cache-commits.bundle`;
  corresponding format patches are retained for review. `git bundle verify`
  passed. Prerequisite commits are already ancestors of the PR. Recover refs
  using `git fetch <bundle-path> 'refs/heads/*:refs/heads/recovered/*'` after
  fetching full PR history. These are experiment variants, not changes to apply
  to the current runtime automatically.
- Fifteen ignored original Python/shell helpers and handoff drafts are copied
  byte-for-byte under `whm-b07d9037-preservation/original-helpers/`; exact paths,
  SHA256 and byte counts are in `original-helper-manifest.json`. Existing
  authoritative secret values were checked before copying; none matched.
- One inherited legacy stash on `andyprevalsky/rose-run-copy` contains
  deploy/explore-recovery source unrelated to current WHM. Its exact source diff,
  including deletion semantics, is retained in `legacy-stash-source.patch`.
  The complete stash Git object/telemetry is separately preserved privately;
  do not apply that unrelated patch to the WHM runtime.
- Untracked original timing JSONLs: one in resume (October10), three in merge
  (October10–12). They are runtime evidence, preserved privately. `agents/venv`
  is a link to root dependencies, not authored source. Complete dependency
  manifests and committed vendored wheels remain in the PR.

## Run12 and owned runtime

The original authorized run is terminal; exact original identities were:

- Run directory: `rose-wmh-resume/.context/wmh-resume-20261009/fundraiser/run12-messaging60m`.
- Run ID: `wmh-raise-5m-rose-labs-brex-1791845194`; Hub UUID
  `6f4ddc5c-6874-4121-b36e-ca5f2f34ce81`; root
  `65889659-9f08-4488-917e-9611223be811`; native session
  `78d15f8582e54904891498644fe4c1da`.
- Source: `39a0433b8850f38996c7fb1433c043998b6f9eeb`;
  `SEED_MESSAGE_LIMIT=100000`; source DB `wmh_fixture_source_20261012`;
  per-run initial state `fundraiser/context/run-state-messaging-20261012.json`.
- Exact launcher PID3856322; WMH owner3856384/native child3856610;
  local wrapper4013847; benchmark child4020038;
  stack4014291, backend4018028, supervisor4019355/worker4019372.
- Linux boot ID `6af9c450-c2c8-4647-a911-8ab19a296bbf`;
  benchmark birth tick11608304; stack birth tick11605700. Verify native birth
  again before any cooperative cleanup. Original owner receipts are in the
  exact `.context/benchmarks/<run-id>/` directory and remain authoritative.
- Backend28600, WMH28690; fresh isolated benchmark DB
  `victoria_bench_wmh_raise_5m_rose_labs_brex_1791845194`.
- At23:44:57 UTC: revision98, six in-flight operations, six ACTIVE/five
  COMPLETED agents, 424 messages. This is progress, not acceptance or cleanup.

Run12 naturally finished at23:49:23 UTC with a3600-second execution-window
timeout,0/1 passed and3665.3 seconds measured duration. Its benchmark and stack
cleanup receipts both report clean; the WMH scope retired and all exact owners
are absent. The native session joined at revision105 with105 world steps.
The final simulation had79 research attempts,3 outreach attempts,6 submission
attempts and1 intake attempt, with0 commitments, signed instruments or settled
proceeds. This is an incomplete fundraiser outcome, not a repaired goal.

`whm-b07d9037-preservation/run12-summary.json` records metered WMH usage:
18,443,391 total input,17,673,634 cached input(95.82638%),700,143 output;
DEMO0/116 hits and107 stores.108 metered calls cannot certify final usage for
every116 lookup attempt. The separate task-agent cache statistic is79.2%.
The existing publisher verified the durable FE replay in a fresh browser
with55 messages at https://www.roselabs.ai/?agent-id=65889659-9f08-4488-917e-9611223be811.

Normal original launcher cleanup removed its benchmark database before the
migration snapshot. No missing database bytes were fabricated: original final
transcript/native state and seeded fixture data remain available. The two
source fixtures and prior owned workspace DB were consistently dumped for
private preservation. No duplicate paid run is permitted.

## Private state and setup

Native model root is `/home/boxes/rose-wmh-resume/.context/world-model-native-resume`.
Static model/RAG data totals11,278,508,882 bytes in15 regular files; native
dynamic records, original fixture dumps, initial states, raw A/B captures,
logs/LLM dumps and local database snapshots need private capture after quiescence.
`private_archive.py` streams gzip into bounded authenticated AES256-GCM frames,
using the existing `TRACE_ARCHIVE_ENCRYPTION_KEY_B64` and private R2 archive
configuration. It verifies each original file remained unchanged, reads the
entire remote object back and authenticates all frames and stream hashes. An
embedded exact-file manifest validates restoration. No raw runtime contents,
environment values or transcripts belong in this PR. Archive receipts contain
only object location, counts, digests and encryption key ID.

Authoritative env paths: `/home/boxes/rose/agents/.env`, `back-end/.env`,
`front-end/.env`; both WHM worktrees link those complete files. Read current
CLAUDE setup guidance. Agents Python3.11.9, native experiential Python3.12;
installed root npm trees and vendored dependencies. Fresh replacement uses a
new workspace/database/Temporal queue; never inherit old runtime identity.
Native load requires the documented memory scope and>=40GB swap; old box has
44GB+10GB swap and bounded serving scope. Do not lose the recovered model by
silently rebuilding a substitute. Restore private archives into an empty staging
directory, verify manifests, then place files deliberately without overwriting.

## Validation and next steps

New migration checks: original tracked source clean, ancestor checks passed,
cache Git bundle verification passed, exact helper checksums retained. Historical
replacement offline checks reported189 passes; they remain separate from this
checkpoint's original run. Broader task acceptance and merge/deploy remain held.

Completed: all original source and important private state are saved. Six
private archives have passed authenticated remote download/decryption and every
original archive-member SHA256 check on the old box. The complete preservation
manifest and nonsecret archive receipts are in `whm-b07d9037-preservation/`.
Raw original Claude/subagent context is privately encrypted, not in Git.

The complete checkpoint is pushed and verified remotely. The replacement's
correct checkout, authenticated original-member restoration and meaningful
continuation are independently verified below. The only pending migration
operation is managed OLD archival; original task acceptance remains incomplete.

The bare upstream mirror at `/home/boxes/mirror-work/world-model-harness.git`
has main and cli-help feature tips matching native upstream reads exactly.
Its local rose-pin tag is retained in the complete private Git bundle. A full verified Git bundle is preserved privately,
with the exact CLI-help commit patch included in the PR for accounting. It is
an upstream reference, not task-owned changes requiring a separate PR.

Archive validation reproduced R2 InvalidPart on the original32MB four-frame
mirror capture: only the first part included the24-byte format header. R2
requires equal non-trailing part lengths. The migration helper now buffers the
ciphertext stream into fixed8MiB physical parts, independent of encryption
frames. The same original archive now uploads, authenticates, restores all5
files, and passes streaming per-member SHA256 checks. Large captures use this
fixed implementation. Only this helper's owned multipart uploads were aborted;
original task files and resource controllers were untouched.

Full preservation receipts cover 44485 original members, 23144595408 original bytes and 4131361474 ciphertext bytes across six private artifacts. Independent authenticated/decrypted member verification from the new box is mandatory before archival. The durable key is the existing trace archive key, ID `trace-archive-prod-2026-07-03`, preserved privately with original dotenvs and expected in fresh project setup. Latest skill revision is `724321f5d5e50cc9b817cdccdbb83579db7141fc`, installed for both harnesses including managed Codex discovery.

Replacement startup disposition: the first full-checkpoint start and one
explicitly authorized generation2 both returned nonretryable
`agent_start_failed`. Supported complete child inventory shows failed status,
no native thread, no execution instance and no active turn for both children.
The exact failed receipts and complete nonsecret replacement prompt are in
`whm-b07d9037-preservation/`. No further starts are attempted from the old box;
the coordinator then created one supported root-owned replacement. Original
files and all six private captures remain saved; that replacement's independent
member verification and meaningful continuation are complete below.

The coordinator's ONE supported root-owned start has now been accepted:
new devbox `e9afcffd-7ba9-4bfd-8703-d770952fe1c3`, internal thread
`ph7cc73xma14jdg6chxpnhbgth8g7c1a`, native
`01a132a3-ea1f-7b22-abfb-70608400d02e`,
[replacement thread](https://boxes.dev/thread/thr_d2e1b555d6314abe8d9f74da7dd979aa).
The actual start key is `swap-harness-whm-20261012-full-checkpoint-coordinator-generation1`,
request `407eed10-adb1-4d76-b4f3-36aa96b29cd0`; the earlier keys failed terminally
before any execution attachment. The accepted prompt retains complete
checkpoint `677068533e050195c62afc8118f3d35a8511f5ea` and all six archive
verification requirements. Launch receipt is in `whm-b07d9037-preservation/`.
Independent restoration and meaningful continuation were subsequently verified
in the receipt below. OLD archival is now ready to request.

## Verified continuation and OLD archive intent

The new Codex replacement independently authenticated/decrypted every original
member across all six private archives:44,485members,23,144,595,408source bytes.
It restored15static native files and44,439runtime files into empty staging and
usable task paths, verified15original helpers/four exact cache refs/full Git
bundle, and read original result/retirement hashes exactly. Its original-task
continuation inspected the frozen42,910-message fixture, ran26owning offline
clock/stream tests, folded116/116 original canonical requests without new model
calls, and analyzed the original trajectory and historical quality A/B.

The durable [NEW continuation receipt](https://github.com/Rose-Ai-Labs/rose/blob/63eb4817c2f05cd70d147007a2dc7b9ec39c43ef/docs/handoffs/swap-harness-b07d9037-81f9-4c97-80d7-6f4d42b7adc1-resumed.json)
was independently read back from GitHub by the old worker and compared against
all six original object identities/counts/ciphertext/gzip/manifest hashes,
source helper/bundle hashes, exact cache commits and original evidence hashes.
All checks passed. The new task continues on
[e9afcffd Codex thread](https://boxes.dev/thread/thr_d2e1b555d6314abe8d9f74da7dd979aa).
Fundraiser acceptance remains incomplete and merge/deploy remains held. Serving
the recovered model still needs the documented>=40GB swap/memory scope preflight;
the artifacts are restored, and that remaining original-task setup is not source loss.

Final late-state check: original three worktrees retain clean tracked source;
original helper hashes still match; benchmark and stack receipts are clean;
all exact task/WMH/worker and migration-upload owners are absent. No important
original task state remains unsaved. Private copies/keys remain durable and
accessible from the replacement. No new paid benchmark/model calls, merge,
deployment, Freedom changes or protected instruction weakening occurred.

The old worker will now request its own b07d9037 archive using the supported
managed operation. This paragraph records intent; acceptance and actual deletion
are separate and must be reported honestly. After acceptance the worker returns
immediately; the coordinator verifies actual archival. Do not message the old
box after the request, because that cancels pending destruction. Continue in
the linked new thread. Full nonsecret final checks are in
`whm-b07d9037-preservation/old-box-closeout.json`.
