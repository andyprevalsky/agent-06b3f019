"""One simulated clock per WMH world (root agent scope).

    agent action at t ──commit(elapsed)──▶ agent time = max(time, t + elapsed)
    wait(deadline) ──▶ resumes when shared time ≥ deadline
    shared time = min(running agents' times ∪ waiting agents' deadlines)

A parent idle on live children (it has not acted since spawning them) is
excluded from shared time; each finished child moves it to at least that
child's finish, so it resumes at the latest child's finish. A parent acting
beside its children moves to a child's finish only when it receives that
child's result. A parent blocked in a call awaiting child results (hold ..
release) holds on its children like an idle one, even if it acted before; a parent
that keeps acting beside its children holds shared time like any agent. When every included agent waits, shared
time is the earliest deadline, so the earliest waiter always wakes (no
deadlock). Model thinking takes no world time. Updates are heap-backed:
O(log n) per change, one clock per world, no state shared across worlds.
"""

from __future__ import annotations

import asyncio
import heapq
from dataclasses import dataclass, field


@dataclass
class _Agent:
    time_ms: int
    parent: str | None = None
    deadline_ms: int | None = None
    done: bool = False
    acted: bool = False
    live_children: set = field(default_factory=set)
    acting: bool = True
    # Open calls in which this agent is blocked awaiting its children's results.
    holds: set = field(default_factory=set)
    children_finish_ms: int = 0
    version: int = 0
    event: asyncio.Event | None = None


class WorldClock:
    def __init__(self, start_ms: int):
        self.start_ms = int(start_ms)
        self._agents: dict[str, _Agent] = {}
        self._heap: list[tuple[int, int, str]] = []
        self._waiters: list[tuple[int, int, str]] = []
        self._waits: dict[tuple[str, str], int] = {}

    # -- state ---------------------------------------------------------------

    @staticmethod
    def _holding(agent: _Agent) -> bool:
        """Idle on live children, or blocked in a call awaiting their results."""
        return bool(agent.live_children) and (not agent.acting or bool(agent.holds)) and agent.deadline_ms is None

    @staticmethod
    def _key(agent: _Agent) -> int | None:
        if agent.done or WorldClock._holding(agent):
            return None
        return agent.deadline_ms if agent.deadline_ms is not None else agent.time_ms

    def _touch(self, agent_id: str) -> None:
        agent = self._agents[agent_id]
        agent.version += 1
        key = self._key(agent)
        if key is not None:
            heapq.heappush(self._heap, (key, agent.version, agent_id))
        if agent.deadline_ms is not None and not agent.done:
            heapq.heappush(self._waiters, (agent.deadline_ms, agent.version, agent_id))

    def _current(self, entry: tuple[int, int, str]) -> bool:
        key, version, agent_id = entry
        agent = self._agents.get(agent_id)
        return agent is not None and agent.version == version and self._key(agent) == key

    def shared_time(self) -> int | None:
        while self._heap and not self._current(self._heap[0]):
            heapq.heappop(self._heap)
        return self._heap[0][0] if self._heap else None

    def _release(self) -> None:
        shared = self.shared_time()
        while self._waiters:
            deadline, version, agent_id = self._waiters[0]
            agent = self._agents[agent_id]
            if agent.version != version or agent.deadline_ms != deadline or agent.done:
                heapq.heappop(self._waiters)
                continue
            if shared is None or deadline > shared:
                return
            heapq.heappop(self._waiters)
            agent.time_ms = max(agent.time_ms, deadline)
            agent.deadline_ms = None
            self._touch(agent_id)
            if agent.event is not None:
                agent.event.set()

    # -- lifecycle -----------------------------------------------------------

    def register(self, agent_id: str, parent: str | None = None) -> int:
        """Add an agent at its parent's time (or shared time); idempotent."""
        if parent is not None and parent not in self._agents:
            self.register(parent)
        existing = self._agents.get(agent_id)
        if existing is not None:
            if parent is not None and existing.parent is None and not existing.acted and agent_id != parent:
                existing.parent = parent
                existing.time_ms = self._agents[parent].time_ms
                self._agents[parent].live_children.add(agent_id)
                self._agents[parent].acting = False
                self._touch(parent)
                self._touch(agent_id)
                self._release()
            return existing.time_ms
        if parent is not None:
            start = self._agents[parent].time_ms
        else:
            shared = self.shared_time()
            start = self.start_ms if shared is None else shared
        self._agents[agent_id] = _Agent(time_ms=start, parent=parent)
        if parent is not None:
            self._agents[parent].live_children.add(agent_id)
            self._agents[parent].acting = False
            self._touch(parent)
        self._touch(agent_id)
        self._release()
        return start

    def action_time(self, agent_id: str) -> int:
        """The world time at which this agent's next action starts."""
        self.register(agent_id)
        agent = self._agents[agent_id]
        agent.acted = True
        if not agent.acting:
            agent.acting = True
            self._touch(agent_id)
        return agent.time_ms

    def commit(self, agent_id: str, *, started_ms: int, elapsed_ms: int) -> int:
        self.register(agent_id)
        agent = self._agents[agent_id]
        agent.acted = True
        agent.acting = True
        agent.time_ms = max(agent.time_ms, int(started_ms) + max(0, int(elapsed_ms)))
        self._touch(agent_id)
        self._release()
        return agent.time_ms

    def finish(self, agent_id: str) -> None:
        self.register(agent_id)
        agent = self._agents[agent_id]
        if agent.done:
            return
        agent.done = True
        agent.deadline_ms = None
        self._touch(agent_id)
        if agent.parent is not None:
            parent = self._agents[agent.parent]
            parent.live_children.discard(agent_id)
            parent.children_finish_ms = max(parent.children_finish_ms, agent.time_ms)
            if not parent.acting:
                # A parent idle on its children resumes at their finish. An
                # acting parent keeps its own time until it receives the result.
                parent.time_ms = max(parent.time_ms, parent.children_finish_ms)
            self._touch(agent.parent)
        self._release()

    def hold(self, agent_id: str, hold_id: str) -> int:
        """The agent is blocked in a call awaiting its children's results; idempotent per hold_id."""
        self.register(agent_id)
        agent = self._agents[agent_id]
        if hold_id not in agent.holds:
            agent.holds.add(hold_id)
            self._touch(agent_id)
            self._release()
        return agent.time_ms

    def release(self, agent_id: str, hold_id: str, children) -> int:
        """The awaiting call returned with these children's results: receive them and resume acting."""
        self.register(agent_id)
        agent = self._agents[agent_id]
        agent.holds.discard(hold_id)
        if not agent.holds:
            agent.acting = True
        return self.receive(agent_id, children)

    def receive(self, agent_id: str, children) -> int:
        """The agent receives finished children's results: it moves to their finish."""
        self.register(agent_id)
        agent = self._agents[agent_id]
        for child_id in children:
            child = self._agents.get(child_id)
            if child is not None and child.done and child.parent == agent_id:
                agent.time_ms = max(agent.time_ms, child.time_ms)
        self._touch(agent_id)
        self._release()
        return agent.time_ms

    async def wait(
        self,
        agent_id: str,
        wait_id: str,
        *,
        until_ms: int | None = None,
        duration_ms: int | None = None,
        poll_seconds: float = 50,
    ) -> dict:
        """Block until shared time reaches the deadline, or return unresumed after a poll."""
        self.register(agent_id)
        agent = self._agents[agent_id]
        key = (agent_id, wait_id)
        if key not in self._waits:
            if (until_ms is None) == (duration_ms is None):
                raise ValueError("A world-clock wait needs exactly one of until_ms or duration_ms")
            deadline = int(until_ms) if until_ms is not None else agent.time_ms + max(0, int(duration_ms))
            self._waits[key] = max(deadline, agent.time_ms)
        deadline = self._waits[key]
        if agent.time_ms >= deadline:
            return {"resumed": True, "time_ms": agent.time_ms, "deadline_ms": deadline}
        if agent.deadline_ms != deadline:
            agent.deadline_ms = deadline
            agent.event = asyncio.Event()
            self._touch(agent_id)
            self._release()
        event = agent.event
        if not event.is_set():
            try:
                await asyncio.wait_for(asyncio.shield(event.wait()), poll_seconds)
            except TimeoutError:
                return {"resumed": False, "time_ms": agent.time_ms, "deadline_ms": deadline}
        return {"resumed": True, "time_ms": agent.time_ms, "deadline_ms": deadline}

    # -- views ---------------------------------------------------------------

    def time_of(self, agent_id: str) -> int:
        return self._agents[agent_id].time_ms

    def snapshot(self) -> dict:
        def state(agent: _Agent) -> str:
            if agent.done:
                return "done"
            if WorldClock._holding(agent):
                return "waiting_on_children"
            return "waiting" if agent.deadline_ms is not None else "running"

        return {
            "start_ms": self.start_ms,
            "shared_time_ms": self.shared_time(),
            "agents": [
                {
                    "agent_id": agent_id,
                    "parent": agent.parent,
                    "time_ms": agent.time_ms,
                    "state": state(agent),
                    "deadline_ms": agent.deadline_ms,
                }
                for agent_id, agent in self._agents.items()
            ],
        }
