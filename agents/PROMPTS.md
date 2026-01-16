# Prompt Routing Guide

Quick reference for modifying agent prompts.

## Structure (6 sections)

All prompts follow this structure:

1. **Identity** - who, timestamp
2. **Critical Constraints** - invariants box (parallel execution, ephemeral sessions, causal deps)
3. **Current Phase** - workflow for PLAN/EXECUTE/FIRST_CALL
4. **Tool Guidance** - HOW to use tools, with `<good-example>` and `<bad-example>` tags
5. **Rules** - behavioral constraints (file handling, tool-first execution, etc.)
6. **Output Format** - JSON shape `{reasoning, response, tool_calls}`

## Where to Make Changes

| Change Type | Location | File |
|-------------|----------|------|
| New invariant | Add to `CRITICAL_CONSTRAINTS_BOX` constant | `helpers/prompts.py` |
| Ephemeral session rules | Already in constraints box + planner CRITICAL REMINDERS | `helpers/prompts.py` |
| Tool behavior guidance | Add to Tool Guidance section with example | `helpers/prompts.py` |
| New behavioral rule | Add to `BEHAVIORAL_RULES` constant | `helpers/prompts.py` |
| File handling rule | Add to `FILE_RULES` constant | `helpers/prompts.py` |
| Phase-specific workflow | Modify Current Phase section in `build_system_prompt()` | `helpers/prompts.py` |
| Planner planning rules | Modify `build_planner_system_prompt()` | `helpers/prompts.py` |
| Browser agent behavior | Modify `build_browser_system_prompt()` | `helpers/prompts.py` |
| Param populator rules | Modify `_build_agent_system_prompt()` | `activities/param_populator.py` |

## Shared Constants

These constants are reused across prompts - edit once, applies everywhere:

```python
# helpers/prompts.py

CRITICAL_CONSTRAINTS_BOX  # Parallel execution, ephemeral sessions, causal deps
FILE_RULES                # file_pointer types, attachments, no re-downloading
BEHAVIORAL_RULES          # Tool-first, no simulation, pivot after 2 failures
```

## Invariants Checklist

Before deploying prompt changes, verify these are present:

- [ ] **Parallel execution** - in Critical Constraints box
- [ ] **Ephemeral sessions** - in Critical Constraints box AND planner CRITICAL REMINDERS
- [ ] **Causal dependencies** - in Critical Constraints box
- [ ] **file_pointer rule** - in FILE_RULES constant
- [ ] **attempt_completion alone** - in Tool Guidance (must be only tool in turn)
- [ ] **send_message_to_user alone** - in Tool Guidance (must be only tool in turn)
- [ ] **set_plan → attempt_completion** - in Current Phase (PLAN section)

## Adding Good/Bad Examples

Use XML tags for inline examples in Tool Guidance:

```
<bad-example>
spawn_browser_agent("Login to site")
spawn_browser_agent("Add to cart")  ← SESSION LOST!
</bad-example>

<good-example>
spawn_browser_agent("Login, add to cart, checkout")  ← Full flow
</good-example>
```

## Files Overview

| File | Purpose |
|------|---------|
| `helpers/prompts.py` | Main prompt builders, shared constants |
| `activities/param_populator.py` | DAG task parameter population prompts |
| `activities/reasoning.py` | DAG reasoning task prompts |
| `tools/spawn_browser_agent_v3.py` | Browser agent spawning (uses `build_browser_system_prompt`) |
| `tools/spawn_claude_code_agent.py` | Claude Code agent spawning |
| `tools/knowledge_base.py` | Blueprint compression prompts |
