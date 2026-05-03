# Prompt Audit Fix Plan

Tracker for the user-prioritized fixes from the 6-agent prompt audit (April 2026).
Status legend: ☐ pending · ◐ in-progress · ☑ done · ⊘ skipped per user

---

## Cross-Cutting Foundation (do first; blocks downstream)

### Verification standardization (§1.1, A5, B2, C5, G1)
- ☐ Single canonical `VERIFICATION_RULES` block; remove restatements across `utils/prompts.py`, `tools/prompts/attempt_completion.py`, `EXPLORE_AGENT_SYSTEM_PROMPT`, planner prompt
- ☐ `attempt_completion` schema = `{tool: Literal["attempt_completion"]}` ONLY — no `result` field
- ☐ Sub-agent → parent handoff: use `response_text` (assistant narration) instead of `result` arg
- ☐ All verifier call sites use rose-1-ultra + claude_token (uniform)
- ☐ One `_run_verifier` helper used by every site (browser, claude-code, post-DAG, plan, execute)
- ☐ `attempt_completion` description states clearly: "verifier feedback returns as a TOOL message in next iteration"

### Single source of truth for tool descriptions (A1)
- ☐ Pydantic Field descriptions = canonical
- ☐ `tools/prompts/<tool>.py` = system-prompt-level usage notes only (when/why to use, exclusivity, return shape)
- ☐ Delete docstrings on tool classes that duplicate `Field(description=...)`
- ☐ Research note: confirm Pydantic-as-canonical is the right choice (Pydantic AI / Anthropic guidance)

### Typed tool registry (B7)
- ☐ Define `ToolRegistry: dict[ToolName, ToolModel]` typed alias
- ☐ Single `render_tool_list(registry)` function; deterministic ordering (sorted by tool name)
- ☐ All sites that render tool lists use this function

### Delete ghost tools (A2, F1, F2, F3, F10, F11, B6)
- ☐ Delete `PeopleSearchTool`, `DeepResearchTool`, `SearchUserNetworkTool`, `FindAllTool`, `EnrichTool`, `MonitorTool`, `CheckMonitorEventsTool`, `SearchX402BazaarTool`, `PayForX402BazaarServiceTool`, `EnableWritePermissionsTool`, `SendSmsTool`, `SendSmsAsUserTool`, `SendEmailTool`, `ProgressToAutonomousExecutionPhaseTool`
- ☐ Delete `SubAgentConfig` (replaced by SpawnAgentTool)
- ☐ Delete `add_memory` and `read_memories` tools entirely (per B6)
- ☐ Delete `build_browser_system_prompt` (utils/prompts.py:531; dead Stagehand-era code)
- ☐ Delete `is_first_call` parameter (declared, never read)
- ☐ Remove all references in `EXPLORE_AGENT_TOOLS`, `EXECUTE_PHASE_TOOLS`, prompts, etc.

---

## Verifier System (§3)

- ☐ C1: Rewrite Worked Examples A, B, E in `_VERIFIER_STATIC_PROMPT` to match new "single-transformation populatability" rubric
- ☐ C2: Stop dropping `structured_response` when score < 1.0 (return partial)
- ☐ C3: Remove `score_reasoning` field from verifier schema entirely
- ☐ C5: Pipe verifier feedback as the TOOL result of `attempt_completion`; add to its description
- ☐ C6: Track post-DAG verifier cost via `_track_tokens_and_cost`
- ☐ C7: Remove dead `is_plan_loop` hardcoding inside `_run_verifier`
- ☐ C8: Sane behavior when verifier called without response_schema (don't dump irrelevant rubric)
- ☐ C10: Browser verifier: infer satisfaction from tool results + end state (not just current DOM)
- ☐ C11: Browser verifier: include screenshot of final state in its context
- ☐ C12: `verifier_claude_code` threshold → 1.0 (was 0.8 — child reports "✅ SUCCESS" parent rejects)
- ☐ C13: Remove `requires Rose model` `ValueError` path (we standardize on rose-1-ultra anyway)
- ☐ C14: Verifier sees the SAME windowed context the agent saw (not full untruncated history)

---

## Cache Discipline (§2)

- ☐ B1: NO datetimes in any system prompt static prefix. Timestamps live on user/assistant/tool messages only.
  - Sites to fix: `EXPLORE_AGENT_SYSTEM_PROMPT`, `spawn_browser_agent_v3/service.py:158`, `contextBuilder.ts:559`, `helpers/summarize.py:236`, `spawn_claude_code_agent/service.py:134-138`
- ☐ B3: Volatile sections (hierarchy/attention/messages) in supervisor → move into trailing user message instead of system prompt
- ☐ B4: TS LLM call sites add `cache_control` markers (router, generator, supervisor)
- ☐ B7: Single `render_tool_list(registry)` (also handles cache stability)

### Browser agent dynamic data (#6)
- ☐ Pull `current_time` and `current_url` out of `spawn_browser_agent_v3` static system prompt
- ☐ Inject as a user message at the end of each tool turn (e.g. `[STATE: time=… url=…]`)

---

## Schema Generation `setResponseSchema.ts` (§5)

- ☐ E1: Add few-shot examples to schema-gen prompt
- ☐ E2: Tell LLM to avoid catch-all names (`result`, `output`, `answer`); be specific
- ☐ E3: Drop `minItems: 1` requirement (single-field schemas are fine)
- ☐ E4: Fix lying-required fields on RouterLlm internal schema
- ☐ E5: Extend type enum with object/dict/nested where feasible
- ☐ E6: `mode` field becomes proper `enum: ['plan','execute']`
- ☐ E9: Mirror best practices from `claude-code-src/` and `agents/` folder; ensure max-tokens retry path exists
- ☐ C9: Schema-gen prompt only emits MUST-HAVE fields, not nice-to-haves

---

## Browser-use Cleanup (A3, F7, H6)

- ☐ A3: Delete legacy browser-use code that v3 obsoletes (carefully — browser-use is the DOM action middleman)
- ☐ F7: Remove `done` action; everything routes through `attempt_completion`
- ☐ H6: Shrink browser-use step envelope toward `{thinking, action}` (drop `evaluation_previous_goal`, `memory`, `next_goal`)
- ☐ Generate browser action list from `BROWSER_USE_TOOLS` registry (don't hand-write in `service.py:154`)
- ☐ Action description gaps fix:
  - `extract` vs `evaluate` overlap clarified
  - `select_dropdown` only-`<select>` (not ARIA) noted
  - `scroll(pages=10)` description matches reality OR implement true scroll-to-bottom
  - `wait` "30s cap" enforced or removed from doc

---

## Bloat / Token Polish (§7)

- ☐ G1: One canonical "verifier reads tool results" statement; delete 5 restatements
- ☐ G2: Compress PLAN-phase ASCII state machine art (keep clarity)
- ☐ G3: Drop duplicate Anti-patterns / Execution restatements
- ☐ G4: Tighten Verifier EVIDENCE-FIRST + COMMON PITFALLS + FEEDBACK without losing signal
- ☐ G5: Drop duplicated CRITICAL_CONSTRAINTS_BOX
- ☐ G6: Single planner "3-8 task target" statement
- ☐ G7: Trim spawn_sub_agent_for_each example block to one strong example
- ☐ G8: EXPLORE prompt: 5x "call attempt_completion" → 1x
- ☐ G9: Verifier worked examples — drop the redundant A vs D pair

---

## Architecture Tightening (§8)

- ☐ H6: Browser-use envelope shrink (above)
- ☐ A4: Keep ORIGINAL user message in context alongside paraphrased sub-goals (don't drop the source-of-truth)

---

## Tool-Level Issues (§9, "fix safe + obvious")

- ☐ I1 attempt_completion docs (folded into Verification standardization)
- ☐ I2 web_fetch missing excerpts/full_content args in description
- ☐ I3 5 spawn aliases — add required-arg docs
- ☐ I4 set_plan post-condition wrong (DAG short-circuits run_agent)
- ☐ I5 spawn_agent contradiction (cookies persist vs sessions ephemeral) — rewrite per nuance
- ☐ I6 web_search/web_fetch/grep/read_memories phantom redirects (`grep` and `read_memories` going away anyway)
- ☐ I7 reasoning.py — add input/output contract
- ☐ I8 message_person.py — approval semantics + param shape
- ☐ I9 add_memory — DELETED instead
- ☐ I10 `tools/prompts/__init__.py` — remove "single source of truth" claim
- ☐ I11 grep — DELETED
- ☐ I12, I13, I14 — standardize tool prompt format

---

## F13 — Dig deeper

- ☐ PLAN-phase node `ASK_QUESTION` says "loop back to RESEARCH" but enabled tools list doesn't allow it. Read state machine + enabled tools and reconcile.

---

## F12 — Fix worked-example E lie

- ☐ "Screenshots automatically captured on completion" — only true for browser. Scope it.

---

## Tests / Structural Enforcement

- ☐ Test: no datetime/now/Date.now in any static system prefix (regex over prompt files)
- ☐ Test: every entry in `TOOL_MODELS` is in at least one phase list
- ☐ Test: byte-identity of `_VERIFIER_STATIC_PROMPT` across `_run_verifier` call sites
- ☐ Test: no semantic-pointer duplication (e.g., "verifier reads tool results" appears once)
- ☐ Test: timestamps present on USER/ASSISTANT/TOOL messages (sample or invariant)
- ☐ Test: tool registry render is deterministic (sorted)
- ☐ Test: `attempt_completion` Pydantic schema has only `tool` field
- ☐ Test: sub-agent attempt_completion path uses `response_text` not `result`
- ☐ Test: verifier called via `_run_verifier` from every site (no hand-rolled paths)

---

## Skipped per user

- §4 Security/prompt-injection (D1–D11) — entire section deferred
- A6 — same
- C4 (>=1.0 boundary loop) — accepted
- E7 (temp 0.3 fine), E8 (Rose Ultra forced — fine for now)
- F4, F5, F8 — minor
- G10, G11 — primer copy
- H2, H3, H4, H7, H8 — architectural
- §10 — no new items beyond what's listed

---

## Execution waves

**Wave 1 (parallel, independent files):**
- W1.1 `utils/prompts.py` cleanup + verification standardization
- W1.2 `utils/tool_schemas.py` ghost-tool deletion + finalize AttemptCompletion + RouterLlm fix
- W1.3 `helpers/llm.py` verifier standardization
- W1.4 `setResponseSchema.ts` rewrite
- W1.5 `domains/spawn_browser_agent_v3/*` browser dynamic-data move + verifier updates
- W1.6 `providers/rose/browser_use.py` envelope/done cleanup + action list from registry

**Wave 2 (depends on Wave 1):**
- W2.1 `tools/prompts/*` align with new schema (delete dead, polish remaining)
- W2.2 `loop/run_agent.py` verifier integration + context filtering
- W2.3 `domains/spawn_claude_code_agent/service.py` verifier-threshold + use unified path
- W2.4 TS supervisor / chat / generator cache-control + volatile-section move

**Wave 3:**
- W3.1 Cross-verify all changes (sub-agents)
- W3.2 Tests added to enforce structural invariants
- W3.3 Run full test suite
- W3.4 Re-spawn audit agents to comb for issues
