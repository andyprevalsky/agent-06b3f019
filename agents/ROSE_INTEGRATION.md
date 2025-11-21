# Rose Model Integration - Agent Workflows

## Overview

The agent workflows have been updated to automatically route Rose model requests to the backend instead of OpenRouter. This enables:
- **Transparent model pooling**: Agents use Rose models without knowing the underlying model selection
- **Cost optimization**: Models are selected from cost-effective pools
- **Simplified configuration**: No changes needed in agent code when model pools change

## How It Works

When an agent workflow calls an LLM function with a Rose model:

1. **Model Detection**: The LLM helper checks if the model name starts with `"rose"` or is `"rose-ultra"`
2. **Route Selection**: 
   - **Rose models** → Backend URL (`BACKEND_API_URL`)
   - **Other models** → OpenRouter URL
3. **Authentication**: Uses `BACKEND_API_KEY` for backend calls (X-API-Key header)
4. **Transparent Operation**: Agent receives responses without knowing the actual model used

## Code Changes

### agents/helpers/llm.py

Both `call_llm_structured()` and `call_llm()` functions now include:

```python
# Check if this is a Rose model - route to backend instead of OpenRouter
is_rose_model = model and (model.lower().startswith('rose') or model.lower() == 'rose-ultra')

if is_rose_model:
    # Use backend URL and backend API key for Rose models
    client = AsyncOpenAI(
        api_key=config.backend.api_key,
        base_url=config.backend.api_url,
        default_headers={"X-API-Key": config.backend.api_key}
    )
    logger.info(f"🌹 Routing Rose model to backend: {model} → {config.backend.api_url}")
else:
    # Use OpenRouter for all other models
    client = AsyncOpenAI(
        api_key=config.openrouter.api_key,
        base_url=config.openrouter.base_url
    )
```

## Environment Variables Required

Make sure these are set in your agent environment:

```bash
# Backend configuration (required for Rose models)
BACKEND_API_URL=http://localhost:3001
BACKEND_API_KEY=your-backend-api-key

# OpenRouter configuration (for non-Rose models)
OPENROUTER_API_KEY=your-openrouter-api-key
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

## Using Rose Models in Agents

### Creating an Agent with Rose

```typescript
// When creating an agent, just specify "rose" or "rose-ultra" as the model
const agent = await createAgent({
  userId: user.id,
  goal: "Research and summarize recent AI developments",
  model: "rose",  // Automatically routed to backend
  tools: ["web_search", "deep_research"],
  verifier: {
    type: "FLOAT_LLM_JUDGE",
    llmJudgePrompt: "Score completion of research task"
  }
});
```

### Updating Existing Agent Model

```typescript
// Change agent to use Rose Ultra
await updateAgent(agentId, {
  model: "rose-ultra"  // Will route to backend for all future LLM calls
});
```

## Model Routing Examples

| Model Name | Routes To | Uses | Notes |
|------------|-----------|------|-------|
| `rose` | Backend (`/v1/chat/completions`) | Pool: Kimi, Claude, DeepSeek, Gemini | Cost-effective workhorse |
| `rose-ultra` | Backend (`/v1/chat/completions`) | Pool: Claude 4.5, GPT-5 | Premium performance |
| `anthropic/claude-sonnet-4.5` | OpenRouter | Direct model | No pooling |
| `openai/gpt-5` | OpenRouter | Direct model | No pooling |

## Logs and Monitoring

When an agent uses a Rose model, you'll see logs like:

```
🌹 Routing Rose model to backend: rose → http://localhost:3001
🎲 Model selection: rose → deepseek/deepseek-chat-v3.1
```

The first log is from the agent workflow, the second from the backend Rose router.

## Benefits

1. **Transparent Pooling**: Agents don't need to know about model pools
2. **Cost Control**: Backend manages model selection based on cost/performance
3. **Easy Updates**: Change model pools without updating agent code
4. **Consistent Interface**: Same OpenAI-compatible API for all models
5. **Authentication**: Backend handles auth and validates requests

## Testing

Test the routing with a simple agent:

```python
# In agent workflow, this will automatically route to backend
action = await workflow.execute_activity(
    decide_next_action,
    args=[context, tools, tool_names, iteration, "rose", "low", user_id, user_phone],
    start_to_close_timeout=timedelta(seconds=60),
)
```

Check logs to verify:
- Agent logs: `🌹 Routing Rose model to backend`
- Backend logs: `🎲 Model selection: rose → [actual model]`

## Troubleshooting

### Agent can't reach backend

**Error**: Connection refused or timeout

**Solution**: Ensure `BACKEND_API_URL` points to running backend:
```bash
# Local development
BACKEND_API_URL=http://localhost:3001

# Production
BACKEND_API_URL=https://your-backend.onrender.com
```

### Authentication failed

**Error**: "Missing or invalid authorization header"

**Solution**: Verify `BACKEND_API_KEY` matches the key in backend's `.env`:
```bash
# Must match backend's BACKEND_API_KEY
BACKEND_API_KEY=your-secret-key
```

### Model not recognized

**Error**: "Unknown model: rose"

**Solution**: 
1. Ensure backend server is running
2. Check Rose router is registered at `/v1/chat/completions`
3. Verify model name is lowercase (use `"rose"` not `"Rose"`)

## Implementation Checklist

- [x] Update `call_llm_structured()` to route Rose models
- [x] Update `call_llm()` to route Rose models
- [x] Add logging for Rose model routing
- [x] Set up backend authentication for agents
- [x] Test with both Rose and Rose Ultra
- [x] Document environment variables
- [x] Create troubleshooting guide

## Future Enhancements

- Add metrics for Rose model usage
- Track cost savings from pooling
- Implement model health checks
- Add fallback to OpenRouter if backend unavailable







