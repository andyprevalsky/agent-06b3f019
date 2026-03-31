# Context Pointers

## Context

Information degrades when passing between agents. The parent LLM reads tool results and user messages, then *rewrites* them into goal strings for children. Each rewrite loses fidelity — phone numbers transposed, names misspelled, nuanced instructions flattened. With agent trees up to 4 levels deep, critical data arrives corrupted at leaf agents.

**Solution:** Pointer-based context passing. User messages and tool results get `@ref:message:<id>` pointers. LLMs pass pointers verbatim. At every LLM call boundary, pointers are resolved to original data from DB.

## Architecture

```
EMISSION (context_utils.py)          RESOLUTION (llm.py)
┌─────────────────────┐             ┌─────────────────────────┐
│ USER msg (id=abc)    │             │ build_llm_messages()    │
│ + "\nReference:      │  ─────►    │   resolve_pointers()    │
│   @ref:message:abc"  │             │   → <resolved-ref>      │
│                      │             │     original text        │
│ TOOL result (id=xyz) │             │     </resolved-ref>      │
│ + "\nReference:      │             │                         │
│   @ref:message:xyz"  │             │ Same for: call_llm,     │
└─────────────────────┘             │ check_progress, planner  │
                                    └─────────────────────────┘
```

## Implementation Steps

### 1. Core pointer module — `agents/helpers/context_pointers.py` (NEW)

```python
@dataclass
class Pointer:
    id: str               # Message UUID
    start: str | None      # Slice start anchor
    end: str | None        # Slice end anchor
    raw: str              # Original matched string

POINTER_PATTERN = re.compile(
    r'@ref:message:([a-f0-9-]+)'
    r'(?:\[start="([^"]+)"\|end="([^"]+)"\])?'
)
```

Functions:
- `parse_pointers(text) → list[Pointer]` — regex extraction
- `annotate_with_pointer(msg: Dict) → None` — appends `\nReference: @ref:message:<id>` to msg text. Only for role=USER or role=TOOL with toolStatus=FINISHED. Idempotent (checks if already annotated).
- `resolve_pointers_in_text(text, local_context) → str` — finds all `@ref:message:` tokens, resolves each from local_context (by message_id) then DB fallback, applies slice if present, wraps in `<resolved-ref>` XML blocks. Unresolvable pointers left in place.
- `resolve_pointers_in_messages(messages, local_context) → list` — applies resolve_pointers_in_text to each message's content field (handles both string and list-of-blocks format).
- `_apply_slice(text, start, end) → str` — find start anchor, find end anchor after it, extract substring. Falls back to full text if anchor not found.
- `_fetch_message_text(message_id) → str | None` — calls backend `POST /api/agents/messages/batch`, cached in-process dict.

### 2. Backend batch message lookup — `back-end/src/routes/agents.ts`

Add `POST /api/agents/messages/batch` (before the `/:id` catch-all):
- Body: `{ ids: string[] }` (max 50)
- Returns: `{ messages: { id, text, role }[] }`
- Filter: only return role=USER or role=TOOL (reject ASSISTANT/SYSTEM)
- Auth: hybridAuth (internal API key)

### 3. Pointer emission — `agents/loop/context_utils.py`

In `poll_and_update_context()`, after appending each new message to context:
```python
from helpers.context_pointers import annotate_with_pointer
for msg in new_msgs:
    if msg not in context:
        annotate_with_pointer(msg)  # mutates msg.text in-place
        context.append(msg)
```

Also annotate initial context in `agents/loop/run_agent.py` at startup.

### 4. Pointer resolution — `agents/helpers/llm.py`

Four integration points, all after messages are built but before API call:

**4a. `build_llm_messages()` (line ~565)** — covers main loop (PLAN + EXECUTE) + explore agent
```python
messages = await resolve_pointers_in_messages(messages, local_context=context)
return messages
```
`context` is already the first param of this function.

**4b. `convert_context_to_messages()` (line 175)** — covers verifier. Currently sync — make it async. Only caller is `check_progress` (line 1953) which is already async.
```python
async def convert_context_to_messages(...):
    # ... existing code ...
    messages = await resolve_pointers_in_messages(messages, local_context=context)
    return messages
```

**4c. `call_llm()` (line 1438)** — covers message_person. Already async activity.
```python
messages = await resolve_pointers_in_messages(messages)
```
No local_context available here — falls back to DB batch fetch.

**4d. `call_planner_llm_activity()` (line 2410)** — covers planner.
```python
full_messages = await resolve_pointers_in_messages(full_messages)
```

### 5. Agent network grep sources

Two new sources — explicit about what you're searching:

**5a. `back-end/src/routes/data.ts`** — add to VALID_SOURCES:
```typescript
agent_network_user_messages: {
  description: 'User messages across the agent network',
  table: 'Message' as const,
  searchField: 'text',
  groupBy: 'agentId',
},
agent_network_tool_results: {
  description: 'Tool call results across the agent network',
  table: 'Message' as const,
  searchField: 'text',
  groupBy: 'agentId',
},
```

Shared code path for both `agent_network_*` sources:
- Requires `agent_id` in request body
- Walk `parentAgentId` to root, find all agents in tree
- `agent_network_user_messages`: `WHERE role='USER' AND agentId IN (tree) AND text ILIKE pattern`
- `agent_network_tool_results`: `WHERE role='TOOL' AND metadata->>'toolStatus'='FINISHED' AND agentId IN (tree) AND text ILIKE pattern`
- Each result includes `@ref:message:<message_id>` pointer in output

**5b. `agents/tools/grep.py`** — pass `agent_id` to backend when source starts with `agent_network_`. Already available in execute_tool signature.

**5c. `agents/helpers/tool_schemas.py`** — update GrepTool.source field:
```python
source: str = Field(
    default="messages",
    description="Data source to search. "
    "'messages' = iMessage/email threads. "
    "'agent_network_user_messages' = user messages across the agent network (all agents in this workflow tree). "
    "'agent_network_tool_results' = tool call results across the agent network (search results, research findings, etc.)."
)
```

### 6. Prompt discipline — `agents/helpers/prompts.py` + `agents/activities/param_populator.py`

**6a. Main agent prompt — `build_system_prompt()` (PLAN + EXECUTE):**

Add to prompt:
```
# Agent Network & Context Pointers
You are part of a network of agents working on interconnected tasks generated through recursive
task decomposition. Your parent agent decomposed a larger goal into sub-tasks, and you may
decompose your own tasks further into child agents.

Messages and tool results in your context include "Reference: @ref:message:<id>" pointers.
These reference the original data in the agent network — use them instead of rewriting:
- PREFER passing @ref:message: pointers in tool arguments and goal strings over rewriting content
- Do NOT paraphrase referenced content — the pointer preserves the original exactly
- Use @ref:message:<id>[start="prefix"|end="suffix"] to reference a substring
- Pointers are resolved automatically before each LLM call

You can search across the agent network using grep:
- source="agent_network_user_messages" — search user messages across all agents in this workflow
- source="agent_network_tool_results" — search tool results (research findings, search results, etc.) across all agents
```

**6b. Explore agent prompt — `EXPLORE_AGENT_SYSTEM_PROMPT`:**

Add to GREP USAGE section:
```
AGENT NETWORK SEARCH:
You are part of a network of agents working on interconnected tasks via recursive task decomposition.
You can search across the entire agent network's data:
- source="agent_network_user_messages" — search what users said across all agents in this workflow tree
- source="agent_network_tool_results" — search tool results from all agents (web searches, research, lookups, etc.)
Use these to find data that other agents in the network have already gathered, avoiding redundant searches.
```

**6c. Param populator prompt — `agents/activities/param_populator.py` `_build_agent_system_prompt()`:**

Add to the prompt (after the grading rules, before CURRENT TASK):
```
CONTEXT POINTERS (CRITICAL):
Messages and tool results in the conversation include "Reference: @ref:message:<id>" pointers.
When populating tool parameters (especially goal strings for spawn_agent):
- PREFER including @ref:message: pointers over rewriting/paraphrasing the referenced content
- The pointer is automatically resolved to the original data when the child agent runs
- This prevents information loss — phone numbers, names, and details stay exact
- Use @ref:message:<id>[start="prefix"|end="suffix"] to reference a specific substring
- Example: Instead of rewriting "Call John Smith at 555-1234", pass the pointer:
  "Call the person mentioned in @ref:message:abc123[start="John Smith"|end="555-1234"]"
```

**6d. Planner prompt — `build_planner_system_prompt()`:**

Add:
```
CONTEXT POINTERS:
When decomposing tasks, embed @ref:message: pointers in sub-task goals rather than
summarizing the referenced data. This prevents information degradation across the agent network.
```

### 7. Tests

**`agents/tests/test_context_pointers.py`** (NEW):
- `parse_pointers`: full pointer, sliced, multiple, none, malformed
- `annotate_with_pointer`: USER gets annotation, TOOL FINISHED gets annotation, ASSISTANT does not, idempotent
- `_apply_slice`: start+end match, start-only fallback, no-match fallback to full text
- `resolve_pointers_in_text`: resolves from local_context, handles missing gracefully, sliced resolution
- `resolve_pointers_in_messages`: string content, list-of-blocks content, no pointers unchanged

**`back-end/src/tests/api-test-suite.ts`**:
- `POST /api/agents/messages/batch` — returns by IDs, filters out ASSISTANT
- `POST /api/data/grep` with `source: agent_network_user_messages` — searches tree USER messages, includes pointers
- `POST /api/data/grep` with `source: agent_network_tool_results` — searches tree TOOL results, includes pointers

## Key Files

| File | Change |
|------|--------|
| `agents/helpers/context_pointers.py` | NEW — pointer types, parsing, emission, resolution |
| `agents/helpers/llm.py` | 4 resolution integration points |
| `agents/loop/context_utils.py` | Pointer emission on message poll |
| `agents/loop/run_agent.py` | Annotate initial context |
| `agents/helpers/prompts.py` | Agent network awareness + pointer discipline in system prompts |
| `agents/activities/param_populator.py` | "Prefer pointers" guidance in param populator prompt |
| `agents/tools/grep.py` | Pass agent_id for agent_network_* sources |
| `agents/helpers/tool_schemas.py` | Two new grep sources in description |
| `back-end/src/routes/agents.ts` | Batch message lookup endpoint |
| `back-end/src/routes/data.ts` | agent_network_user_messages + agent_network_tool_results grep sources |
| `agents/tests/test_context_pointers.py` | NEW — unit tests |

## Execution Order

1. `agents/helpers/context_pointers.py` + tests (no dependencies)
2. `back-end/src/routes/agents.ts` batch endpoint (no dependencies)
3. `agents/loop/context_utils.py` + `run_agent.py` emission (depends on 1)
4. `agents/helpers/llm.py` resolution integration (depends on 1, 2)
5. `agents/helpers/prompts.py` prompt discipline (independent)
6. `back-end/src/routes/data.ts` + `grep.py` + `tool_schemas.py` grep source (independent)
7. Backend API tests (depends on 2, 6)

## Gotchas

- **Temporal determinism**: All resolution happens inside activities (not workflow code). `build_llm_messages` is called from `call_llm_activity` (an activity). Safe.
- **2MB payload**: Resolution expands messages *inside* the activity, after the `_pending_llm_context` handoff. Never crosses Temporal payload boundary.
- **convert_context_to_messages sync→async**: Only caller is `check_progress` (already async). Low risk.
- **Cache**: Messages are immutable in DB — in-process cache on `_fetch_message_text` needs no TTL.
- **Circular resolution**: `<resolved-ref>` blocks don't contain `@ref:message:` patterns, so no recursion.

## Verification (all automated)

```bash
# 1. Unit tests — pointer parsing, emission, slicing, resolution
cd agents && python -m pytest tests/test_context_pointers.py -v

# 2. Backend API tests — batch message lookup, agent_network_* grep sources
cd back-end && npm run test:api

# 3. Run all existing tests to ensure no regressions
cd back-end && npm run test:api && cd ../agents && python tests/run_all_tests.py
```

All tests must pass before `/deploy`. No manual verification steps — everything is covered by the test suites above.
