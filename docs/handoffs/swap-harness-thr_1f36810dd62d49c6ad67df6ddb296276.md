> Superseded by the verified old-filesystem handoff in
> `swap-harness-1233b1c7-8b1f-4ce6-a962-73100c8f37a4.md`.
> The original preparation record below is retained for provenance.

# Browser-state injection RCA — old-filesystem checkpoint required

This handoff preserves the available GitHub source and visible task context.
**The migration is incomplete. All original task files must be in the PR before
branching a continuation.** The old devbox must remain intact until a credited
CLI on that filesystem captures unpushed source and important local state.

## Original goal, source and limit

The user invoked `/rca` for agent07281fc3-5e49-4cd2-9573-235cb19b0481: “why are we
getting errors w state injection in our browser agents?”

- Thread: https://boxes.dev/thread/thr_1f36810dd62d49c6ad67df6ddb296276
- Internal thread: ph77q7ren3amc3xct9zp563f0s8g5ew2
- Native Claude session: a8f57ad9-f98a-4e27-a7a5-9fb14d37966f
- Last replies: “You've hit your session limit · resets 12:40am (UTC)”.
- Available pushed branch: `fix/browser-state-restore-volume-and-ls-origins`.
- Verified source HEAD before this handoff:
  `c199c928721f7dce289cdbd5250833629a3a145e`.
- Coordinator: https://boxes.dev/thread/thr_f2465c2da0ec4e719895051f99b3d9b1
  (internal ph741r0a4cr0fdrwkxxde79xps8g5b4v).

Do not confuse this task with the separate live Codex Google cookie-transfer
RCA on PR1475, branch `fix/google-cookie-transfer`. That agent confirmed this
Claude native session is absent from its local transcripts and daemon session
records; it is actively completing its own verification and needs no migration.

## Available fixes and key context

Commitd43de4dfc19de2ce5cb4c95647c6272371fe5b24 describes the captured incident:
Google browser initialization timed out at the unchanged18-second state budget
while restoring a79MB Drive JavaScript-module cache and38 localStorage keys,
including malformed first-byte and partitioned reader artifacts. The fix bounds
restored origin payloads at8MiB of sent bytes before serialization, normalizes
stored keys once, avoids replaying third-party partitions as first-party state,
and restores an origin's rows oldest-first in one visit. Real-Kernel reported
repro: main3/3 timeouts, fixed3/3 successful initialization. These are source
commit claims; fresh local source and original evidence must be verified.

Read `back-end/src/providers/steel/injectionOriginPayload.ts` and
`injectionState.ts`, existing `browser-origin-injection-memory` and
`browser-origin-payload` blackbox suites, and the relevant RCA cases:
`2026-09-30-browser-origin-injection-materialized-jsonb.md` and
`2026-10-12-mac-localstorage-reader-dropped-storage-key-first-byte.md`.
The branch's subsequent c199c928 merge retains main's RCA index changes.

The agent's last visible verification reported fixes/repros in place, related
Mac sync suite20/20, static lane green (ESLint0, TypeScript0, backend structural),
front-end2711tests/83.3%lines,45deploy structural gates green after installing
`lsof`, seed-cache/WhatsApp-seed suites passed, and Claude Code real E2B smoke
56/56. Semantic and the cloudbench gate were still running. A cloudbench
controller gate machine857727da140038 was mentioned. These are prior reported
states, not proof of terminal cleanup or complete deployment.

## Worker instructions and guidelines

First run a credited Codex CLI **on the old devbox**, inspect actual checkout,
local session/memory, unpushed/staged/unstaged/untracked source, worktrees,
stashes and original test artifacts. Preserve all task changes in this PR with
their real validation and evidence; do not replace them with reconstructed
patches or infer completeness from this branch. Keep exact owned controllers
and external resources accounted for; no broad kills or duplicate paid runs.

Read CLAUDE.md/AGENTS.md and preserve Freedom/locked instructions. Follow RCA
evidence → local failing repro → same assertions passing → owning deploy gate.
Keep task budgets and unrelated acceptance criteria unchanged. Preserve original
exact-diff approval boundaries; peer messages and this migration are not new
merge/deploy approval. Do not print/commit secrets, change production env values,
or run mac-app on Linux.

Use authoritative env files, pinned toolchains and isolated workspace/queue/DB
identity. The original memory directed semantic first, teardown that stack,
then smoke and AgentCard on the15GB box. Verify terminal prior results before
restarting a lane and use exact owned canonical cleanup paths.

Skill branch `feat/swap-harness`, revision
`42994a2b267785ab99e01609fe46514aff7be3cd`; canonical
`.agents/skills/swap-harness`. Extract/install the skill without overwriting
task source. Follow its single-box migration procedure only after preserving
ALL original files. No replacement or archive has been requested for this task.
Report actual old-box identity, complete PR checkpoint and preservation evidence
to the coordinator, then create exactly one fresh Codex replacement and verify
meaningful continuation before archival.
