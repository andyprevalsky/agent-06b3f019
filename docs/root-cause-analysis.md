# Root Cause Analysis Guidelines

These guidelines define how to diagnose bugs in this codebase. Follow this methodology exactly — do NOT skip steps.

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

Once you have found the most upstream suspicious point, reproduce the failure in the smallest environment that still exercises the same mechanism. This is required before writing the fix whenever the bug can be isolated without losing the behavior under investigation.

The isolated reproduction should:
- Use the same critical code path or boundary where the data first goes wrong
- Remove unrelated services, network calls, benchmarks, retries, and UI layers
- Run quickly enough to iterate repeatedly while fixing
- Fail before the fix and pass after the fix
- Preserve the exact behavior being diagnosed, not a similar but different bug

If an isolated reproduction is not feasible, state why explicitly and use the narrowest available integration test or benchmark rerun instead. Do not use the benchmark itself as the only reproduction when a smaller one can prove the same causal mechanism.

## Step 4: Classify the failure

Not all errors are bugs in our code. Before writing a fix, classify:

| Classification | Example | Correct response |
|---|---|---|
| **Our bug** — our code produces wrong output given valid input | JSON parse error on well-formed LLM response | Fix our code |
| **Third-party failure** — external service returns an error | 402 out of credits, 429 rate limited, provider outage | Surface the error clearly to the user; do NOT add fallbacks that mask it |
| **Input error** — bad data entered the system | Malformed user goal, missing required field | Validate at the system boundary where the input enters; do NOT patch downstream handlers |
| **Configuration error** — missing env var, expired token, wrong URL | TEMPORAL_ADDRESS not set, expired Claude OAuth token | Report the specific missing config; do NOT add "works without it" fallbacks |
| **Test bug** — the test itself asserts the wrong thing | Test expects old API shape after a schema change | Fix the test, not the production code |

**The critical rule:** Third-party failures and configuration errors are NOT bugs in our code. Never write code to "handle" a 402 by falling back to a different provider silently. Never write code to "handle" a missing env var by using a default. These mask real problems. Surface them to the user.

## Step 5: State your hypothesis explicitly

Before writing any fix, state ALL of these:

1. **What** — the observed wrong behavior (the symptom)
2. **Where** — the root cause location (file, function, line)
3. **Why** — the causal chain from root cause to symptom
4. **Proof** — the specific log line, DB query result, or isolated reproduction step that confirms causation

If you cannot fill in all four, you have not found the root cause yet. Keep investigating.

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
- Eliminate the **class** of bug, not just the **instance**
- Respect encapsulation — fix it in the layer that owns the responsibility
- Don't duplicate logic that already exists elsewhere (search the codebase first)
- Don't add new code paths that aren't tested
- Follow existing patterns in the codebase for similar problems

## Anti-patterns (never do these)

1. **"Pre-existing, I'll skip it"** — "Pre-existing" is NEVER an acceptable diagnosis. Just because an error exists in code you didn't touch doesn't mean you aren't responsible for fixing it. This codebase is maintained by multiple agents working in parallel, each of which will naturally produce some amount of uncaught errors. If nobody owns the errors they encounter, the codebase degrades with every commit. You are the immune system — every bug you encounter and walk past is a bug that compounds. If you find it, you fix it. No exceptions.

2. **Defensive fallback** — Wrapping a broken call in try/catch with a default value. This hides the bug and makes it harder to find later. The system should fail loudly when something is wrong.

3. **Symptom patch** — Fixing the downstream effect instead of the upstream cause. Example: reformatting a malformed string in the frontend instead of fixing the backend that produced it.

4. **Speculative handling** — Adding error handling for a failure mode you haven't actually seen or reproduced. If you can't trigger it, you can't verify your fix works either.

5. **Silent degradation** — Catching an error and continuing with partial or wrong data instead of failing loudly. The user and the developer both need to know when something breaks.

6. **Wrong-layer fix** — Adding a workaround in service A for a bug that lives in service B. Even if service A's workaround "fixes" the symptom, the bug in service B will bite again from a different caller.

7. **Correlation-as-causation** — Two things happened near each other in time, so one must have caused the other. Temporal proximity is not proof. Trace the actual data flow.
