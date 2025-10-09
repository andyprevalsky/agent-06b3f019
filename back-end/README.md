# Navi Agent Management Backend

TypeScript backend API for managing AI agents with Prisma ORM and PostgreSQL.

## Features

- 🔐 Authentication via Supabase JWT tokens
- 📊 Agent management (CRUD operations)
- 💬 Real-time message streaming via WebSocket
- 🤖 LLM judge prompt formatting
- 🗄️ PostgreSQL with Prisma ORM
- 🚀 Deploy-ready for Render

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Database**: PostgreSQL
- **ORM**: Prisma
- **Auth**: Supabase
- **WebSocket**: ws
- **Validation**: Zod
- **LLM**: OpenAI API

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL database
- Supabase account
- OpenAI API key

### Installation

```bash
# Install dependencies
npm install

# Copy environment template
cp ENV_TEMPLATE .env

# Configure your .env file with actual values
```

### Environment Variables

Create a `.env` file with the following variables:

```env
# Database
DATABASE_URL="postgresql://user:password@host:5432/database?schema=public"

# Supabase (for auth validation)
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_ANON_KEY="your-anon-key"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"

# OpenAI (for LLM judge prompt formatting)
OPENAI_API_KEY="sk-..."

# Server
PORT=3001
NODE_ENV="development"

# CORS (comma-separated allowed origins)
ALLOWED_ORIGINS="http://localhost:5173,https://your-frontend.com"
```

### Database Setup

```bash
# Generate Prisma client
npm run prisma:generate

# Run migrations
npx prisma migrate dev --name init

# (Optional) Open Prisma Studio to view/edit data
npm run prisma:studio
```

### Development

```bash
# Start development server with hot reload
npm run dev
```

The server will start on `http://localhost:3001` (or your configured PORT).

### Production Build

```bash
# Build TypeScript
npm run build

# Start production server
npm start
```

## API Endpoints

All endpoints except `/health` require authentication via `Authorization: Bearer <token>` header.

### Authentication

The backend validates Supabase JWT tokens. Include the token in the Authorization header:

```
Authorization: Bearer <supabase-jwt-token>
```

### Endpoints

#### `GET /health`
Health check endpoint (no auth required).

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

#### `GET /api/agents`
Get all agents for the authenticated user.

**Response:**
```json
{
  "agents": [
    {
      "agent_id": "uuid",
      "progress": 0.5,
      "goal": "Complete task X",
      "status": "ACTIVE",
      "status_message": "Processing...",
      "created_at": "2024-01-01T00:00:00.000Z",
      "updated_at": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

#### `POST /api/agents`
Create a new agent.

**Request:**
```json
{
  "goal": "Complete task X",
  "tool_ids": ["uuid1", "uuid2"],
  "verifier": {
    "type": "FLOAT_LLM_JUDGE",
    "llm_judge_prompt": "Evaluate the output..."
  }
}
```

**Response:**
```json
{
  "agent_id": "uuid",
  "progress": 0.0,
  "goal": "Complete task X",
  "status": "STARTING_UP",
  "status_message": null,
  "created_at": "2024-01-01T00:00:00.000Z",
  "updated_at": "2024-01-01T00:00:00.000Z"
}
```

#### `GET /api/agents/:id`
Get agent details with paginated messages.

**Query Parameters:**
- `cursor` (optional): ISO timestamp for pagination

**Response:**
```json
{
  "agent": {
    "agent_id": "uuid",
    "goal": "Complete task X",
    "progress": 0.5,
    "status": "ACTIVE",
    "status_message": "Processing...",
    "created_at": "2024-01-01T00:00:00.000Z",
    "updated_at": "2024-01-01T00:00:00.000Z",
    "verifier": {
      "type": "FLOAT_LLM_JUDGE",
      "llm_judge_prompt": "..."
    },
    "tools": [
      {
        "id": "uuid",
        "name": "Tool Name",
        "description": "Tool description"
      }
    ]
  },
  "messages": [
    {
      "message_id": "uuid",
      "timestamp": "2024-01-01T00:00:00.000Z",
      "text": "Hello",
      "role": "USER"
    }
  ],
  "pagination": {
    "next_cursor": "2024-01-01T00:00:00.000Z",
    "has_more": true
  }
}
```

#### `POST /api/agents/:id/messages`
Post a message to an agent.

**Request:**
```json
{
  "message": "Hello, agent!"
}
```

**Response:**
```json
{
  "message_id": "uuid",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "text": "Hello, agent!",
  "role": "USER"
}
```

#### `DELETE /api/agents/:id`
Soft delete an agent.

**Response:** 204 No Content

#### `POST /api/format-llm-judge-prompt`
Format an LLM judge prompt using GPT-4.

**Request:**
```json
{
  "text": "Judge if the task is complete"
}
```

**Response:**
```json
{
  "text": "Evaluate the task completion and return a float between 0 and 1..."
}
```

## WebSocket API

Connect to `ws://localhost:3001/ws` for real-time updates.

### Connection Flow

1. **Connect** to WebSocket endpoint
2. **Authenticate** by sending token
3. **Subscribe** to specific agents
4. **Receive updates** in real-time

### Message Types

#### Client → Server

**Authenticate:**
```json
{
  "type": "subscribe",
  "agent_id": "uuid",
  "token": "supabase-jwt-token"
}
```

**Subscribe to agent:**
```json
{
  "type": "subscribe",
  "agent_id": "uuid"
}
```

**Unsubscribe from agent:**
```json
{
  "type": "unsubscribe",
  "agent_id": "uuid"
}
```

**Ping:**
```json
{
  "type": "ping"
}
```

#### Server → Client

**Authenticated:**
```json
{
  "type": "authenticated",
  "user_id": "uuid"
}
```

**Subscribed:**
```json
{
  "type": "subscribed",
  "agent_id": "uuid"
}
```

**New message:**
```json
{
  "type": "new_message",
  "agent_id": "uuid",
  "message": {
    "message_id": "uuid",
    "timestamp": "2024-01-01T00:00:00.000Z",
    "text": "Hello",
    "role": "AGENT"
  }
}
```

**Agent update:**
```json
{
  "type": "update",
  "agent_id": "uuid",
  "data": {
    "progress": 0.75,
    "status": "ACTIVE",
    "status_message": "Almost done..."
  }
}
```

**Pong:**
```json
{
  "type": "pong"
}
```

**Error:**
```json
{
  "type": "error",
  "message": "Error description"
}
```

## Deployment on Render

### Automatic Deployment

1. Push code to GitHub
2. Connect repository to Render
3. Render will detect `render.yaml` and create services automatically
4. Set environment variables in Render dashboard:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `OPENAI_API_KEY`
   - `ALLOWED_ORIGINS`

### Manual Deployment

Alternatively, create services manually in Render dashboard:

1. **Create PostgreSQL database**
   - Name: navi-agent-db
   - Plan: Starter or higher

2. **Create Web Service**
   - Name: navi-agent-backend
   - Build Command: `npm install && npm run prisma:generate && npm run build`
   - Start Command: `npm run prisma:migrate && npm start`
   - Add environment variables
   - Link to PostgreSQL database

## Database Schema

### Agent
- Tracks agent instances with goal, progress, status
- Soft deletes supported
- Associated with Tools and Verifier

### Tool
- Pre-defined tools that agents can use
- Many-to-many relationship with Agents

### Verifier
- One-to-one with Agent
- Currently supports FLOAT_LLM_JUDGE type

### Message
- Chat messages between user and agent
- Roles: SYSTEM, AGENT, USER, TOOL, STATUS
- Paginated retrieval (50 per page)

## Race Condition Prevention

When connecting to WebSocket for real-time updates:

1. Establish WebSocket connection
2. Wait for authentication confirmation
3. Fetch existing messages via REST API
4. Subscribe to agent via WebSocket
5. Deduplicate messages by `message_id`

This ensures no messages are dropped during the connection process.

## Frontend Integration Notes

### Listening to Supabase Realtime (TODO)

For the agent terminal implementation, you'll want to listen to:
- **Agent table**: status, progress, status_message changes
- **Message table**: new messages for the agent

Example Supabase client setup:
```typescript
// Listen to agent updates
supabase
  .channel(`agent:${agentId}`)
  .on('postgres_changes', {
    event: '*',
    schema: 'public',
    table: 'Agent',
    filter: `id=eq.${agentId}`
  }, (payload) => {
    // Handle agent updates
  })
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'Message',
    filter: `agentId=eq.${agentId}`
  }, (payload) => {
    // Handle new messages
  })
  .subscribe()
```

## Development Tips

- Use Prisma Studio to view/edit data: `npm run prisma:studio`
- View logs in development with detailed query logging
- WebSocket connections are logged to console
- Use health check endpoint for monitoring

## License

MIT

