# SMS supervisor: reuse the main agent's 3-block prompt layering

## Goal

Refactor the SMS supervisor's system prompt so it reuses the **same block
skeleton** the main agent already uses (`build_system_prompt`,
`agents/utils/prompts.py:209`): **Block 1 (Rose core) and Block 2 (user
context) are shared/identical; all SMS-specific content lives in Block 3.**

Optimize for prompt-cache hits and **change nothing about the main agent.**

## Context / why this is needed

The main agent and the SMS supervisor grew two parallel system prompts with
near-duplicated core prose:

- Main core: `MAIN_SYSTEM_PROMPT` (`agents/utils/prompts.py:177-206`) — identity/
  seed metaphor, low-energy-COO / bias-to-action, harness auto-escalation
  paragraph. **No per-user interpolation** — names live in a separate `# User
  Context` block (`prompts.py:229`), so Block 1 is byte-identical fleet-wide.
- SMS core: `STATIC_SUPERVISOR_PROMPT_TEMPLATE`
  (`back-end/src/providers/smsSupervisor/contextBuilder.ts:555-603`) — the same
  prose reworded, but with `{USER_NAME}` / `{USER_ASSIGNED_ASSISTANT_NAME}`
  **baked into the identity paragraph** (substituted at `contextBuilder.ts:627-630`).

Two problems fall out of that divergence:

1. **Drift.** The shared philosophy is hand-maintained in two files/languages.
2. **Cache regression.** Because SMS bakes the user's name into Block 1, its
   "static" prefix is *per-user*, so it can never be shared across users. The
   main agent already avoids this; SMS does not.

## Design — SMS adopts main's skeleton verbatim

Main's skeleton, three boundary-separated cacheable blocks then volatile state
in messages (`build_system_prompt`, `prompts.py:225-243`):

```
Block 1: MAIN_SYSTEM_PROMPT        universal core, NO names        ─ BOUNDARY
Block 2: # User Context            per-user (name/phone/address)   ─ BOUNDARY
Block 3: # Current Phase + schema  PLAN/EXECUTE overlay            ─ BOUNDARY
(dynamic per-call state → conversation messages, never the system prompt)
```

SMS maps 1:1 onto it:

```
Block 1: Rose core                 identical shared prose, NO names ─ BOUNDARY
Block 2: # User Context            per-user (name/phone/address)    ─ BOUNDARY
Block 3: SMS surface overlay       ALL SMS-specific content         ─ BOUNDARY
(dynamic state → contextUserMessage, already correct today)
```

### What each "identical" means precisely

- **Block 1 — byte-identical shared core.** Extract the universal prose subset
  that already appears verbatim in `MAIN_SYSTEM_PROMPT` (seed/identity,
  low-energy-COO/bias-to-action, harness auto-escalation/approval) into a single
  **canonical constant** (`ROSE_CORE`). SMS Block 1 renders it verbatim. Main is
  **not** rewired — a drift test asserts `ROSE_CORE` is a byte-exact substring of
  `MAIN_SYSTEM_PROMPT`, so any future edit to main's core forces the canonical
  constant (and thus SMS) to update. Names are removed from SMS Block 1.
  - Note: `MAIN_SYSTEM_PROMPT` *also* carries main-only prose (explore-agent
    grounding, spawn_agent guidance, PLAN/DECOMPOSITION/EXECUTE, grader). That is
    **not** part of `ROSE_CORE`; it stays in main's Block 1 untouched. `ROSE_CORE`
    is only the common subset.
- **Block 2 — identical user-context contract.** Same section header (`# User
  Context`) and same field rendering (name / phone / shipping address) as the
  main path. SMS may render fewer sections (it only sources what it has), but the
  format and ordering of shared fields match. Names move here (out of Block 1).
- **Block 3 — everything SMS-specific.** SMS-supervisor mode framing, the `grep`
  grounding sentence (main's equivalent names `explore`), the "Your Inputs" state-
  block documentation, response rules (concise/texting, never expose IDs,
  attempt_completion sends the SMS + commits writes). This is the analogue of
  main's Block 3 (`# Current Phase`).

### Cache implications

- SMS Block 1 becomes **user-agnostic** → one fleet-wide `ephemeral.global` cache
  entry instead of one per user (the primary cache win). This mirrors main's
  existing behavior; it is "make SMS match main," not "change main."
- SMS Block 3 (surface overlay) is user-agnostic and constant per surface → also
  globally cacheable.
- Adding Block 3 means a third `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`; the existing
  multi-block `markCacheable` path already marks each non-empty section globally
  cacheable (see the cache-layout comment at `contextBuilder.ts:605-619` and
  `agents/providers/rose/claude_auth.py:_build_system_blocks`).
- **Ceiling (explicit):** main and SMS still emit *different* Block-1 bytes
  (main's includes explore/phase/grader), so they do **not** collapse to a single
  shared cache row. That would require restructuring main's block layout, which
  is out of scope. We get identical *structure* + per-surface + cross-user cache
  hits, not one shared main↔SMS cache entry.

## Changes

### `back-end/src/providers/smsSupervisor/contextBuilder.ts`

- Introduce `ROSE_CORE` (canonical shared-core constant) — the universal prose
  subset, no name placeholders.
- Rewrite `assembleSystemPrompt` to emit three boundary-separated blocks:
  `ROSE_CORE` │ `# User Context` (with name/assistant-name) │ SMS surface overlay.
- Move `{USER_NAME}` / assistant-name interpolation out of Block 1 and into
  Block 2's user-context rendering (`formatUserContext`).
- Split the SMS-specific prose (mode framing, grep grounding, "Your Inputs",
  response rules) out of the old template into the Block-3 overlay constant.

### Drift pin (no main-agent change)

- Add a test that reads `ROSE_CORE` and asserts it is a **byte-exact substring**
  of `agents/utils/prompts.py:MAIN_SYSTEM_PROMPT`. Since one side is TS and the
  other Python, pin via a checked-in canonical text artifact both can read, or a
  cross-language snapshot assertion in the backend suite. `MAIN_SYSTEM_PROMPT`
  itself is **not** edited.

## Verification (automated — required before merge)

Add to `back-end/src/tests/blackbox/` (SMS supervisor domain):

- **Block 1 is user-agnostic:** build the SMS system prompt for two different
  users; assert Block 1 (up to the first boundary) is **byte-identical** across
  them. Proves the cross-user cache win.
- **Drift pin:** `ROSE_CORE` is a byte-exact substring of `MAIN_SYSTEM_PROMPT`.
- **Names only in Block 2:** no user name / assistant name appears above the first
  boundary; both appear in Block 2.
- **No dynamic state above the boundary:** datetime, hierarchy, attention
  requests, recent activity never appear in the system prompt (they stay in
  `contextUserMessage`).
- **Shared user-context rendering:** shipping address renders with the same
  format/section header the main path uses.
- **Block 3 is SMS-specific:** grep grounding + "attempt_completion sends the
  SMS" appear in Block 3; PLAN/EXECUTE/grader prose does **not** appear anywhere
  in the SMS prompt.
- **Snapshot** of the fully composed SMS system prompt.

Run: `cd back-end && npm run test:api` (SMS supervisor blackbox), then
`npm run test:coverage` to keep thresholds green.

## Non-goals / boundaries

- **No main-agent changes.** `agents/utils/prompts.py` build path and
  `MAIN_SYSTEM_PROMPT` bytes are untouched; only pinned by a test.
- **No shared main↔SMS cache row** (see ceiling above).
- Browser-only operational context (payment/passkey/decrypted secret refs, live
  Steel session state) stays browser-scoped — not pulled into SMS Block 2.
- Prompt-text edits require fresh human approval per CLAUDE.md rule 25; the
  `ROSE_CORE` extraction is a prompt change and must be approved on its diff.
