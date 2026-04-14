# Claude Code Parity Gaps — Implementation Plan

Closing the gaps between Rose's claudeAuth path and Claude Code's native API usage.
Scope: `research/supabase/functions/completions/index.ts` + `agents/helpers/llm.py` + `agents/loop/run_agent.py`.

---

## Gap 1: Thinking blocks dropped on Anthropic streaming path

**Problem**: The completions endpoint silently discards all Anthropic thinking events.

- **Standard mode** (line 3747): `if (parsed.type !== 'content_block_delta') continue` skips `content_block_start` entirely, so thinking blocks never initialize. Even on `content_block_delta`, only `delta.text` and `delta.partial_json` are extracted (line 3755) — `delta.thinking` is never read.
- **Result**: Agents set `reasoning_max_tokens` and pay for thinking tokens, but never receive them. `accumulated_reasoning` in `llm.py:830` stays empty for all Anthropic models. Only OpenRouter models (which use `delta.reasoning` in the OAI chunk format) work.

**Claude Code behavior**: `claude.ts:2030-2037` initializes thinking blocks on `content_block_start`, then `line 2148-2160` accumulates `delta.thinking` into the content block. Thinking is preserved and displayed.

**Fix** — `completions/index.ts`:

Standard mode needs to handle thinking events. Forward them as `delta.reasoning` in the OAI chunk format (matching what OpenRouter already does, which the agents code already consumes at `llm.py:813`).

```
In standard mode section (lines 3744-3755):

1. Track current block type via a variable (like ntCurrentBlock in native tool mode):
   let anthropicCurrentBlock: string | null = null;

2. On content_block_start:
   - If type === 'thinking': set anthropicCurrentBlock = 'thinking', continue
   - If type === 'text': set anthropicCurrentBlock = 'text', continue

3. On content_block_delta:
   - If delta.thinking (thinking_delta):
     Emit as: { choices: [{ delta: { reasoning: delta.thinking } }], ... }
     Update lastContentTime, set hasReceivedContent = true
   - If delta.text or delta.partial_json (existing logic):
     Emit as content (unchanged)

4. On content_block_stop:
   - Reset anthropicCurrentBlock = null, continue
```

**Files**: `research/supabase/functions/completions/index.ts` (lines 3744-3755)

**Agents side** — no change needed. `llm.py:813` already extracts `delta.reasoning` and accumulates it. Once the endpoint forwards thinking as `reasoning`, it flows through automatically.

**Verification**: Create agent with `reasoning_max_tokens=2048`, check that `accumulated_reasoning` is non-empty in logs. Compare `🧠 REASONING started` log appearing for Anthropic models (currently only appears for OpenRouter).

---

## Gap 2: Always use adaptive thinking

**Problem**: Rose always sends `{ type: "enabled", budget_tokens: N }`. Claude Code uses `{ type: "adaptive" }` — no fixed cap, the model allocates thinking tokens dynamically based on problem difficulty.

**Current code** (`completions/index.ts:4675-4676`):
```typescript
if (cappedReasoning?.max_tokens) {
    anthropicBody.thinking = { type: 'enabled', budget_tokens: cappedReasoning.max_tokens };
}
```

**Fix** — `completions/index.ts`:

Both streaming (line 3400 area) and non-streaming (line 4675) claudeAuth paths — always use adaptive:

```typescript
// Replace the cappedReasoning check with:
anthropicBody.thinking = { type: 'adaptive' };
```

Ignore `cappedReasoning.max_tokens` entirely for Anthropic claudeAuth calls. Adaptive is unconditional.

**Fix** — `agents/helpers/llm.py`:

The `reasoning` field in the request body is still useful for OpenRouter models (which need a budget). For claudeAuth, the endpoint now ignores it and always uses adaptive. No agent-side change needed — the endpoint handles it.

**Fix** — `agents/workflows/agent_workflow.py` + `agents/loop/run_agent.py`:

Optional cleanup: `reasoning_max_tokens` parameter can stay as-is (default 256). It's only consumed by the endpoint for non-claudeAuth paths (OpenRouter). For claudeAuth, the endpoint overrides to adaptive regardless.

**Verification**: Check `anthropicBody.thinking` in endpoint logs shows `{ type: "adaptive" }` for all claudeAuth calls. Confirm no `budget_tokens` field.

---

## Gap 3: No retry on claudeAuth path

**Problem**: The claudeAuth streaming path has stall detection (20s timeout → fall back to racing) but NO retry on transient HTTP errors (500, 502, 503). A single 502 from Anthropic immediately abandons to racing, which may use a worse model.

**Additional issue**: Stall timeout is 20s, which is too aggressive — thinking phases can take longer before emitting content. **Change to 60s.**

**Claude Code behavior**: `withRetry()` wrapper retries transient errors with backoff before giving up.

**Current code** (`completions/index.ts:4611-4648`): Single `handleStreaming()` call wrapped in try/catch. On any exception → `claudeTokenError` set → fall through to racing.

**Fix** — `completions/index.ts`:

**A) Retry around Anthropic fetch (both paths):**

**Non-streaming** (line 4683): Wrap the fetch in a retry loop:
```typescript
let lastError: Error | null = null;
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    const response = await fetch(ANTHROPIC_API_URL, { ... });
    if (response.ok) { /* process */ break; }
    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      await delay(retryAfter);
      continue;
    }
    if (response.status >= 500) {
      await delay(Math.min(2 ** attempt * 1000, 5000));
      continue;
    }
    // 4xx (non-429) = don't retry
    throw new Error(`Anthropic API error: ${response.status}`);
  } catch (e) {
    lastError = e;
    if (attempt < 2) {
      await delay(Math.min(2 ** attempt * 1000, 5000));
      continue;
    }
  }
}
if (lastError) throw lastError;
```

**Streaming** (line 3454): Retry on non-2xx before starting the stream reader:
```typescript
if (!fetchResponse.ok) {
  if (fetchResponse.status === 429 || fetchResponse.status >= 500) {
    const delayMs = fetchResponse.status === 429
      ? parseRetryAfter(fetchResponse.headers.get('retry-after'))
      : 2000;
    await new Promise(r => setTimeout(r, delayMs));
    fetchResponse = await fetch(ANTHROPIC_API_URL, { ... });
  }
}
```

Extract `parseRetryAfter()` from the existing racing retry logic (lines 2493-2510) into a shared helper.

**B) Change stall timeout from 20s to 60s:**

Line 4632: `timeoutMs: 20000` → `timeoutMs: 60000`

This gives thinking phases enough time before triggering stall fallback.

**Verification**: Confirm retry on transient 500s. Confirm stall fallback doesn't trigger during normal thinking phases.

---

## Gap 4: max_tokens too low + no escalation

**Problem**:
- Main agent loop uses `max_tokens=8192` hardcoded
- Non-streaming uses `max_tokens=4096`
- Planner uses `max_tokens=16384`
- No escalation on truncation
- Claude Code starts at `8000`, escalates to `64000` on truncation

**Fix** — `agents/helpers/llm.py`:

In `call_llm_structured_streaming()`, add escalation on truncation:

```python
# After streaming completes, check if response was truncated
# finish_reason === 'length' signals truncation
if finish_reason == 'length' and max_tokens < 32768 and not _is_escalation:
    logger.warning(f"Response truncated at max_tokens={max_tokens}, retrying with 32768")
    return await call_llm_structured_streaming(
        ..., max_tokens=32768, _is_escalation=True
    )
```

Add `_is_escalation: bool = False` parameter to prevent infinite recursion.

Need to capture `finish_reason` from streaming chunks. Currently it's in the final chunk's `choices[0].finish_reason` (for OpenRouter) or inferred from `message_delta` (for Anthropic via completions endpoint).

**Fix** — `completions/index.ts`:

Non-streaming path default (line 4657): Change `max_tokens || 4096` to `max_tokens || 8192`.

**Verification**: Send a prompt that requires a long response. Confirm the agent auto-escalates and the full response arrives.

---

## Gap 5: HTTP timeout mismatch

**Problem**:
- Agents HTTP client timeout: 300s (5 min) for streaming
- Temporal activity `start_to_close_timeout`: 180s (3 min)
- Temporal `heartbeat_timeout`: 60s

HTTP timeout exceeds Temporal activity timeout. Stalled HTTP connections outlive the activity = resource leak.

**Fix** — `agents/helpers/llm.py`:

1. Align HTTP timeout with Temporal: set streaming timeout to `170s` (10s buffer under the 180s activity limit)
2. Add mid-stream stall check: if no chunks for 50s (under 60s heartbeat), emit heartbeat and log warning

```python
# Line 736: Change timeout
timeout = httpx.Timeout(170.0, connect=30.0)

# In streaming loop, track last_chunk_time:
if time.time() - last_chunk_time > 50:
    logger.warning("Stream stall detected (50s no data)")
    if heartbeat_fn:
        heartbeat_fn()  # Keep Temporal alive
```

**Verification**: Confirm stalled streams don't orphan Temporal activities.

---

## Gap 6: Heartbeat during thinking

**Problem**: Heartbeat fires every 5 chunks or on content changes. During thinking phases, Anthropic emits thinking blocks but no content — if thinking takes >60s and heartbeats aren't sent for reasoning chunks, Temporal kills the activity.

With Gap 1 fixed (thinking forwarded as `delta.reasoning`), agents will receive reasoning chunks. But heartbeat logic may only trigger on `delta.content`, not `delta.reasoning`.

**Fix** — `agents/helpers/llm.py`:

Ensure heartbeat fires on reasoning chunks too:
```python
if reasoning_delta or content:
    last_chunk_time = time.time()
    chunk_count += 1
    if chunk_count % 5 == 0:
        heartbeat()
```

**Verification**: Run agent with adaptive thinking on a hard problem. Confirm no Temporal heartbeat timeout during long thinking phases.

---

## Gap 7: Bundle consecutive tool_result messages

**Problem**: `transformMessagesForAnthropic()` emits each `role: "tool"` as a separate `role: "user"` message with one `tool_result` block. If an assistant calls 3 tools, the result is 3 consecutive user messages.

Claude Code bundles all tool results from a single turn into **one** user message with multiple `tool_result` content blocks (`mergeUserMessages()` + `hoistToolResults()`). This is the format shown in Anthropic's API docs.

While Anthropic's 1P API accepts consecutive same-role messages and merges them server-side, this is a compatibility shim — not the intended usage. Bundling is better because:

1. **Semantic clarity** — one user message = one turn boundary. Three separate user messages = ambiguous turn boundaries that the model may interpret differently.
2. **Token efficiency** — each separate message has framing overhead (~20-30 tokens per tool call saved).
3. **API docs compliance** — Anthropic's tool use docs show all tool results in a single user message.

**Fix** — `completions/index.ts`:

After the main transformation loop in `transformMessagesForAnthropic()`, add a bundling pass:

```typescript
// Bundle consecutive tool_result user messages into one
const bundled: any[] = [];
for (const msg of anthropicMessages) {
  const prev = bundled[bundled.length - 1];
  const prevIsToolResult = prev?.role === 'user'
    && Array.isArray(prev.content)
    && prev.content.length > 0
    && prev.content.every((b: any) => b.type === 'tool_result');
  const currIsToolResult = msg.role === 'user'
    && Array.isArray(msg.content)
    && msg.content.length > 0
    && msg.content.every((b: any) => b.type === 'tool_result');

  if (prevIsToolResult && currIsToolResult) {
    prev.content.push(...msg.content);
  } else {
    bundled.push(msg);
  }
}
anthropicMessages = bundled;
```

**Files**: `research/supabase/functions/completions/index.ts` — `transformMessagesForAnthropic()`

**Verification**: Send a request with an assistant message containing 3 tool_calls followed by 3 tool results. Confirm the Anthropic API receives 1 user message with 3 `tool_result` blocks (check via endpoint logging). Add a test case to `test-transform-messages-for-anthropic.mjs`.

---

## Implementation Order

```
Phase 1 (Critical — quality + correctness):
  Gap 1:  Forward thinking blocks           [completions/index.ts]
  Gap 2:  Always adaptive thinking           [completions/index.ts]
  Gap 3:  Retry + 60s stall timeout          [completions/index.ts]

Phase 2 (Performance + correctness):
  Gap 4:  max_tokens escalation              [agents/llm.py, completions/index.ts]
  Gap 7:  Bundle consecutive tool_results    [completions/index.ts]

Phase 3 (Reliability):
  Gap 5:  HTTP/Temporal timeout alignment    [agents/llm.py]
  Gap 6:  Heartbeat during thinking          [agents/llm.py]
```

## Automated Verification

1. **Thinking test**: Create agent, verify `🧠 REASONING started` appears for Anthropic model and `accumulated_reasoning` is non-empty

2. **Adaptive test**: Check endpoint logs show `thinking: { type: "adaptive" }` for all claudeAuth calls

3. **Retry test**: Inject transient 500 before Anthropic fetch. Confirm retry succeeds without falling back to racing

4. **Stall test**: Confirm 60s timeout doesn't trigger during normal thinking phases

5. **Escalation test**: Set `max_tokens=1024` on complex prompt. Confirm auto-retry with 32768

6. **Heartbeat test**: Run agent with long thinking. Confirm no Temporal heartbeat timeout

7. **Bundling test**: 3 tool results → 1 user message with 3 tool_result blocks. Add test to `test-transform-messages-for-anthropic.mjs`

8. **Benchmark**: Run `web_search_simple` before/after. Compare token costs, quality, reliability
