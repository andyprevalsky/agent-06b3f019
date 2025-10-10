# Navi Temporal Agents

Autonomous AI agents built with [Temporal](https://temporal.io) for reliable, long-running task execution.

## Architecture

This system provides:

- **Autonomous Agents**: AI agents that can accomplish complex, multi-step goals
- **State Management**: Temporal Cloud handles all state, persistence, and retry logic
- **Tool Ecosystem**: Modular tools for SMS, web search, browser automation, knowledge base
- **Agent Coordination**: Manage multiple agents, prevent resource conflicts, handle overlapping goals
- **User Intervention Gates**: Require approval for sensitive actions
- **Failure Handling**: Automatic retries, cleanup, and knowledge base logging
- **Scalable Deployment**: Run on fly.io with auto-scaling

## Components

### Workflows

1. **AgentWorkflow** (`workflows/agent_workflow.py`)
   - Main workflow for autonomous task execution
   - Plans and executes steps using available tools
   - Handles retries and errors
   - Updates knowledge base on completion/failure

2. **AgentCoordinator** (`workflows/coordinator_workflow.py`)
   - Manages multiple agents per user
   - Prevents resource conflicts
   - Detects overlapping goals
   - Enforces concurrency limits

3. **ResourceCleanupWorkflow** (`workflows/coordinator_workflow.py`)
   - Cleans up after failed/terminated agents
   - Releases locks and resources
   - Logs failures to knowledge base

### Tools

Each tool is a Temporal Activity in the `tools/` folder:

1. **send_sms** (`tools/send_sms.py`)
   - Send SMS via Twilio
   - Wait for and receive responses
   - `list_contacts`: Get message history

2. **knowledge_base** (`tools/knowledge_base.py`)
   - Query prior solutions/blueprints
   - Add success blueprints
   - Log failure cases

3. **web_search** (`tools/web_search.py`)
   - Search using Serper or Google Custom Search API
   - Returns titles, URLs, snippets

4. **accomplish_web_task** (`tools/web_task.py`)
   - Browser automation via Playwright
   - LLM-powered task planning
   - Execute multi-step web workflows

5. **wait_time** (`tools/wait.py`)
   - Wait for specified duration
   - Handles real-world time requirements (e.g., "cook risotto for 20 minutes")
   - Uses heartbeats for long waits

6. **mark_finished** (`tools/finished.py`)
   - Mark task completion
   - Update knowledge base with blueprint/failure
   - Add message to voice AI chat log

## Configuration

### Required Environment Variables

```bash
# Temporal Cloud (REQUIRED)
TEMPORAL_API_KEY=eyJhbGci...  # Your API key
TEMPORAL_NAMESPACE=quickstart-navi.lqjlv
TEMPORAL_ADDRESS=us-east-1.aws.api.temporal.io:7233
TASK_QUEUE=navi-agent-tasks

# Worker Configuration
MAX_CONCURRENT_ACTIVITIES=500      # Activities running concurrently
MAX_CONCURRENT_WORKFLOWS=200       # Workflow tasks concurrently
MAX_CACHED_WORKFLOWS=1000          # Workflows cached in memory
MAX_CONCURRENT_ACTIVITY_TASK_POLLERS=5
MAX_CONCURRENT_WORKFLOW_TASK_POLLERS=5

# Timeouts (seconds)
ACTIVITY_START_TO_CLOSE_TIMEOUT=300
ACTIVITY_SCHEDULE_TO_CLOSE_TIMEOUT=600
ACTIVITY_HEARTBEAT_TIMEOUT=30
WORKFLOW_EXECUTION_TIMEOUT=86400    # 24 hours
WORKFLOW_RUN_TIMEOUT=86400
WORKFLOW_TASK_TIMEOUT=10

# Retry Policies
ACTIVITY_MAX_ATTEMPTS=5
WORKFLOW_MAX_ATTEMPTS=3

# Backend API
BACKEND_API_URL=https://navi-j9a9.onrender.com
BACKEND_API_KEY=your_backend_api_key

# Supabase (for knowledge base)
SUPABASE_URL=https://kzlurqihzaolhzsbkctf.supabase.co
SUPABASE_KEY=your_supabase_key

# OpenAI (for LLM planning)
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4-turbo-preview

# Twilio (for SMS)
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1234567890

# Web Search (choose one)
SERPER_API_KEY=...          # Recommended: https://serper.dev
# OR
GOOGLE_API_KEY=...
GOOGLE_CSE_ID=...

# Health Check
HEALTH_CHECK_PORT=8080
LOG_LEVEL=INFO
ENVIRONMENT=production
```

### Configuration Parameters Explained

#### Worker Concurrency

- **MAX_CONCURRENT_ACTIVITIES**: Maximum activities executing simultaneously
  - Higher = more parallel tool executions
  - Recommendation: 500 (adjust based on resource limits)
  
- **MAX_CONCURRENT_WORKFLOWS**: Maximum workflow tasks executing simultaneously
  - Higher = more agents can be planned/coordinated concurrently
  - Recommendation: 200
  
- **MAX_CACHED_WORKFLOWS**: How many workflow instances to keep in memory
  - Higher = faster workflow execution, more memory usage
  - Recommendation: 1000

- **MAX_CONCURRENT_ACTIVITY_TASK_POLLERS**: Parallel activity pollers
  - More pollers = faster activity pickup, more network connections
  - Recommendation: 5 (rarely needs adjustment)

- **MAX_CONCURRENT_WORKFLOW_TASK_POLLERS**: Parallel workflow pollers
  - More pollers = faster workflow pickup
  - Recommendation: 5 (rarely needs adjustment)

#### Timeouts

- **ACTIVITY_START_TO_CLOSE_TIMEOUT**: Max time for an activity to complete (300s = 5 min)
- **ACTIVITY_HEARTBEAT_TIMEOUT**: Max time between activity heartbeats (30s)
- **WORKFLOW_EXECUTION_TIMEOUT**: Max total workflow lifetime (86400s = 24 hours)
- **WORKFLOW_RUN_TIMEOUT**: Max time for a single workflow run (86400s)
- **WORKFLOW_TASK_TIMEOUT**: Max time for a single workflow task (10s)

## Local Development

### Setup

```bash
cd agents

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Install Playwright browsers
playwright install chromium

# Copy environment template
cp .env.example .env
# Edit .env with your credentials
```

### Run Worker Locally

```bash
# Activate virtual environment
source venv/bin/activate

# Run worker
python worker.py
```

The worker will:
1. Start health check server on port 8080
2. Connect to Temporal Cloud
3. Start polling for tasks
4. Execute workflows and activities

### Test Agent Execution

Use the Temporal CLI or Web UI to start a workflow:

```bash
# Install Temporal CLI
brew install temporal

# Start an agent workflow
temporal workflow start \
  --type AgentWorkflow \
  --task-queue navi-agent-tasks \
  --workflow-id agent-$(date +%s) \
  --input '{
    "agent_id": "test-agent-1",
    "user_id": "user-123",
    "goal": "Send a test SMS to +19729777432",
    "available_tools": ["send_sms"],
    "verification_method": "Check if SMS was sent successfully"
  }'

# Query workflow progress
temporal workflow query \
  --workflow-id agent-1234567890 \
  --type get_progress
```

## Deployment (fly.io)

### Prerequisites

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Login to fly.io
fly auth login
```

### Initial Deployment

```bash
cd agents

# Launch app (creates app and fly.toml if needed)
fly launch --name navi-temporal-agents --region iad

# Set secrets
fly secrets set \
  TEMPORAL_API_KEY='eyJhbGci...' \
  TEMPORAL_NAMESPACE='quickstart-navi.lqjlv' \
  TEMPORAL_ADDRESS='us-east-1.aws.api.temporal.io:7233' \
  SUPABASE_URL='https://kzlurqihzaolhzsbkctf.supabase.co' \
  SUPABASE_KEY='your_key' \
  OPENAI_API_KEY='sk-proj-...' \
  TWILIO_ACCOUNT_SID='AC...' \
  TWILIO_AUTH_TOKEN='...' \
  TWILIO_PHONE_NUMBER='+1234567890' \
  BACKEND_API_KEY='your_backend_key' \
  SERPER_API_KEY='your_serper_key'

# Deploy
fly deploy
```

### Update Deployment

```bash
# Deploy new version
fly deploy

# View logs
fly logs

# Check status
fly status

# SSH into instance
fly ssh console
```

### Scaling

```bash
# Scale vertically (more CPU/RAM per instance)
fly scale vm shared-cpu-2x --memory 4096

# Scale horizontally (more instances)
fly scale count 3

# Auto-scaling is configured in fly.toml
# min_count = 1
# max_count = 10
```

### Monitor

```bash
# View real-time logs
fly logs

# Check health
curl https://navi-temporal-agents.fly.dev/health

# View metrics
curl https://navi-temporal-agents.fly.dev/metrics

# Temporal Web UI
# Visit: https://cloud.temporal.io
```

## Agent Usage

### Creating an Agent

Agents are created via the backend API:

```bash
curl -X POST https://navi-j9a9.onrender.com/api/agents \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "goal": "Research and send me a summary of the latest AI developments",
    "verification_method": "Summary includes at least 3 recent developments",
    "available_tools": ["web_search", "query_knowledge_base"]
  }'
```

This will:
1. Create an Agent record in the database
2. Start an AgentWorkflow in Temporal
3. Return the agent ID

### Agent Lifecycle

1. **STARTING_UP**: Agent initializing
2. **ACTIVE**: Agent executing tasks
3. **PAUSED**: Waiting for user input/approval
4. **COMPLETED**: Goal accomplished
5. **FAILED**: Could not complete goal

### User Intervention

When an agent needs approval:

```bash
# Check agent status
curl https://navi-j9a9.onrender.com/api/agents/AGENT_ID \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# Approve current step
temporal workflow signal \
  --workflow-id AGENT_ID \
  --name approve_step

# Reject and abort
temporal workflow signal \
  --workflow-id AGENT_ID \
  --name reject_step
```

### Agent Coordination

Multiple agents can run concurrently, managed by AgentCoordinator:

- **Resource Locking**: Prevents multiple agents from using same phone number, account, etc.
- **Goal Detection**: Identifies similar/overlapping goals
- **Concurrency Limits**: Enforces max agents per user (default: 10)

### Killing an Agent

```bash
# Terminate workflow
temporal workflow terminate \
  --workflow-id AGENT_ID \
  --reason "User requested termination"

# This triggers ResourceCleanupWorkflow automatically
```

## Failure Handling

### Automatic Retries

Activities automatically retry on failure:
- Max attempts: 5 (configurable)
- Exponential backoff: 2x multiplier
- Retries transient errors (network, API rate limits)

### Cleanup on Failure

When an agent fails:
1. ResourceCleanupWorkflow is triggered
2. Resource locks are released
3. Failure case logged to knowledge base
4. User is notified

### Monitoring Failures

Check knowledge base for failure patterns:

```bash
curl https://kzlurqihzaolhzsbkctf.supabase.co/rest/v1/KnowledgeBase \
  -H "apikey: YOUR_KEY" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -G \
  --data-urlencode "type=eq.failure" \
  --data-urlencode "userId=eq.YOUR_USER_ID"
```

## Knowledge Base

Agents learn from experience:

### Blueprints (Successes)

When an agent succeeds, it saves a blueprint:
```json
{
  "type": "blueprint",
  "title": "Blueprint: Send SMS to contact",
  "content": {
    "goal": "Send SMS to +1234567890",
    "steps": [
      {"tool": "list_contacts", "action": "Get contacts"},
      {"tool": "send_sms", "action": "Send message"}
    ],
    "outcome": "SMS sent successfully",
    "tools_used": ["list_contacts", "send_sms"]
  }
}
```

### Failure Cases

When an agent fails, it logs the attempt:
```json
{
  "type": "failure",
  "title": "Failure: Book restaurant reservation",
  "content": {
    "goal": "Book table at Chez Panisse",
    "attempted_steps": [...],
    "failure_reason": "Restaurant requires phone call, no online booking",
    "tools_used": ["web_search", "accomplish_web_task"]
  }
}
```

### Querying Knowledge

Agents query the knowledge base before starting:
```python
# Find similar past tasks
results = await query_knowledge_base(
    query="send SMS",
    user_id="user-123",
    limit=5
)
```

## Real-World Time Handling

For tasks that take time (like cooking risotto):

```python
# In workflow
await workflow.execute_activity(
    wait_time,
    args=[],
    kwargs={
        "minutes": 20,
        "reason": "Cooking risotto"
    },
    start_to_close_timeout=timedelta(minutes=25)
)
```

The agent will:
1. Start the wait
2. Send periodic heartbeats
3. Resume after time elapsed
4. Continue with next steps

## Troubleshooting

### Worker won't connect

```bash
# Check Temporal credentials
echo $TEMPORAL_API_KEY
echo $TEMPORAL_NAMESPACE

# Test connection
temporal workflow list --namespace quickstart-navi.lqjlv
```

### Activities timing out

Increase timeouts in `.env`:
```bash
ACTIVITY_START_TO_CLOSE_TIMEOUT=600  # 10 minutes
```

### Out of memory

Reduce cached workflows:
```bash
MAX_CACHED_WORKFLOWS=500
```

Or scale up fly.io instance:
```bash
fly scale vm shared-cpu-2x --memory 4096
```

### High activity failures

Check logs for specific errors:
```bash
fly logs | grep ERROR
```

Common issues:
- API rate limits → Increase retry backoff
- Invalid credentials → Check secrets
- Network timeouts → Increase timeout values

## Architecture Decisions

### Why Temporal?

- **Reliability**: Automatic retries, durable state
- **Long-running**: Handles tasks that take hours/days
- **Debuggability**: Complete execution history
- **Scalability**: Workers auto-scale
- **Developer Experience**: Write normal async Python code

### Why fly.io?

- **Edge Deployment**: Low latency (iad region)
- **Auto-scaling**: Scale workers based on load
- **Health Checks**: Automatic restart on failure
- **Cost-effective**: Pay for what you use

### Why Separate Tools?

- **Modularity**: Easy to add/remove tools
- **Testing**: Test tools independently
- **Reusability**: Share tools across agents
- **Permissions**: Grant specific tools per agent

## Future Enhancements

- [ ] LLM-powered task planning (currently simplified)
- [ ] More sophisticated agent coordination (goal merging)
- [ ] Real-time agent monitoring dashboard
- [ ] Tool usage analytics
- [ ] Multi-modal tool support (images, audio)
- [ ] Agent collaboration (agents working together)
- [ ] Custom tool SDK for users

## Support

- **Temporal Docs**: https://docs.temporal.io
- **fly.io Docs**: https://fly.io/docs
- **GitHub Issues**: [Link to your repo]

