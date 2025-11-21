# Rose Model Router - Usage Guide

## Overview

Rose and Rose Ultra are OpenRouter-compatible endpoints that proxy requests to a pool of models, masking the actual model selection from the user.

## Model Pools

- **Rose**: `moonshotai/kimi-k2-thinking`, `anthropic/claude-sonnet-4.5`, `deepseek/deepseek-chat-v3.1`, `google/gemini-2.5-flash`
- **Rose Ultra**: `anthropic/claude-sonnet-4.5`, `openai/gpt-5`

## Endpoints

### 1. Chat Completions

**Endpoint**: `POST /v1/chat/completions`

**Authentication**: Requires Supabase JWT token in Authorization header

**Example with cURL**:

```bash
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SUPABASE_JWT_TOKEN" \
  -d '{
    "model": "rose",
    "messages": [
      {
        "role": "user",
        "content": "Hello, how are you?"
      }
    ],
    "temperature": 0.7,
    "max_tokens": 150
  }'
```

**Example with Python (OpenAI client)**:

```python
from openai import AsyncOpenAI

# Configure client to point to your backend
client = AsyncOpenAI(
    api_key="YOUR_SUPABASE_JWT_TOKEN",
    base_url="http://localhost:3001"
)

# Call Rose
response = await client.chat.completions.create(
    model="rose",  # or "rose-ultra"
    messages=[
        {"role": "user", "content": "Hello!"}
    ],
    temperature=0.7,
    max_tokens=150
)

print(response.choices[0].message.content)
# The response.model will show "rose" (actual model is masked)
```

**Example with TypeScript/JavaScript**:

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'YOUR_SUPABASE_JWT_TOKEN',
  baseURL: 'http://localhost:3001',
});

const response = await client.chat.completions.create({
  model: 'rose-ultra',
  messages: [
    { role: 'user', content: 'Solve this problem...' }
  ],
  temperature: 0.7,
});

console.log(response.choices[0].message.content);
```

### 2. Cost Calculation

**Endpoint**: `GET /v1/cost/:modelName`

**Authentication**: Requires Supabase JWT token

**Example**:

```bash
curl -X GET http://localhost:3001/v1/cost/rose \
  -H "Authorization: Bearer YOUR_SUPABASE_JWT_TOKEN"
```

**Response**:

```json
{
  "model": "rose",
  "poolSize": 4,
  "contextLength": 200000,
  "pricing": {
    "prompt": "0.05",
    "completion": "0.10"
  }
}
```

### 3. View Models List

Rose and Rose Ultra will appear in the models list:

```bash
curl http://localhost:3001/api/models
```

The response will include:

```json
{
  "models": [
    {
      "id": "rose",
      "name": "★ Rose",
      "provider": "rose-labs",
      "description": "Rose Labs workhorse model for most tasks",
      "contextLength": 200000,
      "pricing": {
        "prompt": "0.05",
        "completion": "0.10"
      }
    },
    {
      "id": "rose-ultra",
      "name": "Rose Ultra",
      "provider": "rose-labs",
      "description": "Rose Labs high-end model for extremely complex tasks",
      "contextLength": 200000,
      "pricing": {
        "prompt": "0.05",
        "completion": "0.10"
      }
    },
    // ... other models
  ]
}
```

### 4. Clear Model Cache

After deploying or updating model pools, clear the cache:

```bash
curl -X DELETE http://localhost:3001/api/models/cache
```

## Using in Agent Workflows

To use Rose models in your agent workflows (`agents/helpers/llm.py`), update the client configuration:

```python
# Instead of pointing to OpenRouter
client = AsyncOpenAI(
    api_key=YOUR_SUPABASE_TOKEN,  # Use Supabase JWT, not OpenRouter key
    base_url="http://localhost:3001"  # Point to your backend
)

# Then use "rose" or "rose-ultra" as model names
response = await client.chat.completions.create(
    model="rose",
    messages=messages,
    temperature=0.7,
    max_tokens=4000
)
```

## Key Features

1. **Model Masking**: The actual model selected from the pool is never revealed to the user
2. **Random Selection**: Each request randomly selects a model from the pool
3. **OpenRouter Compatible**: Works with any OpenRouter-compatible client (OpenAI SDK)
4. **Dynamic Pricing**: Automatically calculates average cost and rounds up to nearest $0.05
5. **Minimum Context Length**: Returns the smallest context window from all models in the pool (ensures compatibility)
6. **Full Authentication**: Uses existing Supabase JWT authentication

## Testing

Start your backend:

```bash
cd back-end
npm run dev
```

Test chat completion with Rose:

```bash
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{"model":"rose","messages":[{"role":"user","content":"Hi!"}]}'
```

Test chat completion with Rose Ultra:

```bash
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{"model":"rose-ultra","messages":[{"role":"user","content":"Solve this complex problem..."}]}'
```

Test cost calculation:

```bash
curl http://localhost:3001/v1/cost/rose \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

View models list (no auth required):

```bash
curl http://localhost:3001/api/models
```

## Notes

- The actual model selected is logged to the console for debugging: `🎲 Model selection: rose → anthropic/claude-sonnet-4.5`
- Model responses show the requested model name ("rose" or "rose-ultra"), never the actual model
- Pricing is calculated as the average of all models in the pool, rounded up to the nearest $0.05

