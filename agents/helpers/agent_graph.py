"""Agent graph from the agents worker: message agents and code agents, route questions.

The backend owns tree scoping, delivery and transcript rows
(``back-end/src/domains/agents/agentGraphService.ts``); these activities are
the worker's thin, retry-safe client::

    Rose agent tool / code-agent monitor
      └─ send_agent_graph_message_activity(AgentGraphSendRequest)
           POST /api/agent-graph/messages   (X-API-Key + X-Agent-Id
                                             [+ X-Code-Session-Id to act as
                                             one of that agent's code sessions])
             ├─ Rose agent target → idempotent USER message
             └─ code agent target → deliverUserTurnToCodeSession → the CLI's
                                    next user turn, once per message id
      └─ ask_code_agent_question_activity(AgentGraphQuestionRequest)
           POST /api/agent-graph/questions  → question routing by spawner

Question routing by spawner (UI ledger 47b): a code agent started by the root
agent asks the user (the root pins it); one started by any other agent sends
the question to that agent, which answers from its context or escalates up
the tree. ``question_route_for_spawner`` is the same rule as the backend's
``questionRouteForSpawner``, for callers that already hold the spawner's
parent link (e.g. the spawning workflow).

Idempotency (CLAUDE.md rule 20): ``message_id`` must be stable across
Temporal retries. ``a2a_message_id`` derives it from the workflow id and the
tool call id; the backend keys rows by (sender, message_id) and the
ws-server dedupes turns by id, so a retried activity never delivers twice.

Payload classes use real annotations (no ``from __future__ import
annotations``): Temporal decodes them inside the workflow sandbox.
"""

import hashlib
import re
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, Dict, List, Literal, Optional, TypedDict

import httpx
import structlog
from temporalio import activity
from temporalio.exceptions import ApplicationError

from config import load_config

logger = structlog.get_logger()

AGENT_GRAPH_ROUTE_PREFIX = "/api/agent-graph"
AGENT_GRAPH_HTTP_TIMEOUT_S = 30.0
_MESSAGE_ID_SAFE = re.compile(r"[^A-Za-z0-9._:-]")
_MAX_MESSAGE_ID_CHARS = 200

# Definite answers that a retry cannot change: wrong scope, bad input, or a
# finished code session.
_NON_RETRYABLE_STATUSES = frozenset({400, 401, 403, 404, 409})


class QuestionRoute(TypedDict):
    deliver_to: Literal["user", "agent"]
    agent_id: str


def question_route_for_spawner(spawner_agent_id: str, spawner_parent_agent_id: Optional[str]) -> QuestionRoute:
    """Root-spawned code agent → ``user`` (root pins); otherwise → its spawning ``agent``."""
    if spawner_parent_agent_id is None or spawner_parent_agent_id == "":
        return {"deliver_to": "user", "agent_id": spawner_agent_id}
    return {"deliver_to": "agent", "agent_id": spawner_agent_id}


def a2a_message_id(workflow_id: str, tool_call_id: str) -> str:
    """Stable per tool call across activity retries and workflow replays."""
    raw = f"{workflow_id}:{tool_call_id}"
    safe = _MESSAGE_ID_SAFE.sub("-", raw)
    if len(safe) <= _MAX_MESSAGE_ID_CHARS:
        return safe
    return f"h-{hashlib.sha256(raw.encode('utf-8')).hexdigest()}"


@dataclass
class AgentGraphSendRequest:
    """Send ``text`` from ``agent_id`` (or one of its code sessions) to ``to``."""

    agent_id: str
    to: str
    text: str
    message_id: str
    code_session_id: Optional[str] = None
    code_provider: Optional[str] = None


@dataclass
class AgentGraphQuestionOption:
    label: str
    description: Optional[str] = None
    recommended: Optional[bool] = None


@dataclass
class AgentGraphQuestionRequest:
    """A code session owned by ``agent_id`` asks a question, routed by its spawner."""

    agent_id: str
    code_session_id: str
    question: str
    message_id: str
    code_provider: Optional[str] = None
    options: List[AgentGraphQuestionOption] = field(default_factory=list)
    allow_other: Optional[bool] = None


def _headers(agent_id: str, code_session_id: Optional[str], code_provider: Optional[str]) -> Dict[str, str]:
    config = load_config()
    headers = {
        "x-api-key": config.backend.api_key or "",
        "x-agent-id": agent_id,
        "Content-Type": "application/json",
    }
    if code_session_id:
        headers["x-code-session-id"] = code_session_id
        headers["x-code-provider"] = code_provider or "claude"
    return headers


def _retry_after(response: httpx.Response) -> Optional[timedelta]:
    """A 429 from the per-sender send budget: retry no sooner than its Retry-After."""
    if response.status_code != 429:
        return None
    try:
        seconds = int(response.headers.get("retry-after", ""))
    except ValueError:
        return None
    return timedelta(seconds=seconds) if seconds > 0 else None


async def _post(path: str, headers: Dict[str, str], body: Dict[str, Any]) -> Dict[str, Any]:
    config = load_config()
    url = f"{config.backend.api_url}{AGENT_GRAPH_ROUTE_PREFIX}{path}"
    async with httpx.AsyncClient(timeout=AGENT_GRAPH_HTTP_TIMEOUT_S) as client:
        response = await client.post(url, headers=headers, json=body)
    if response.status_code >= 400:
        try:
            error = str(response.json().get("error") or response.text)
        except ValueError:
            error = response.text
        raise ApplicationError(
            f"agent graph {path} failed: HTTP {response.status_code} {error[:200]}",
            type="AgentGraphError",
            non_retryable=response.status_code in _NON_RETRYABLE_STATUSES,
            next_retry_delay=_retry_after(response),
        )
    data = response.json()
    return data if isinstance(data, dict) else {"result": data}


@activity.defn
async def send_agent_graph_message_activity(request: AgentGraphSendRequest) -> Dict[str, Any]:
    """Deliver one agent-graph message; safe to retry with the same ``message_id``."""
    result = await _post(
        "/messages",
        _headers(request.agent_id, request.code_session_id, request.code_provider),
        {"to": request.to, "text": request.text, "message_id": request.message_id},
    )
    logger.info(
        "[AgentGraph] Message sent",
        agent_id=request.agent_id,
        code_session_id=request.code_session_id,
        to=request.to,
        message_id=request.message_id,
        status=result.get("status"),
    )
    return result


@activity.defn
async def ask_code_agent_question_activity(request: AgentGraphQuestionRequest) -> Dict[str, Any]:
    """Route a code agent's question by spawner; returns the backend's route + delivery."""
    body: Dict[str, Any] = {"question": request.question, "message_id": request.message_id}
    if request.options:
        body["options"] = [
            {key: value for key, value in vars(option).items() if value is not None} for option in request.options
        ]
    if request.allow_other is not None:
        body["allow_other"] = request.allow_other
    result = await _post(
        "/questions",
        _headers(request.agent_id, request.code_session_id, request.code_provider),
        body,
    )
    logger.info(
        "[AgentGraph] Code agent question routed",
        agent_id=request.agent_id,
        code_session_id=request.code_session_id,
        deliver_to=result.get("deliver_to"),
        route_agent_id=result.get("agent_id"),
        status=result.get("status"),
    )
    return result
