"""Data contracts for planner memory: transcripts in, critical paths out."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

MAX_STEPS = 8
MAX_PITFALLS = 5
MAX_DETOURS = 5
MAX_STRING = 200


def _clip(text: Any, limit: int = MAX_STRING) -> str:
    value = " ".join(str(text or "").split())
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


class EntryPoint(BaseModel):
    tool: str = Field(description="Tool that opened the successful path, e.g. spawn_browser_agent.")
    start_url: Optional[str] = Field(default=None, description="Exact URL opened first, or null.")


class CriticalStep(BaseModel):
    step: int = Field(description="1-based order on the shortest path.")
    tool: str = Field(description="Tool or agent that performed the step.")
    action: str = Field(description="What was done, concrete (URL, selection, form value).")
    result: str = Field(description="What the action produced.")


class Detour(BaseModel):
    tried: str = Field(description="What was attempted and later abandoned.")
    why_it_failed: str = Field(description="Why it did not lead to the outcome.")
    steps_wasted: int = Field(description="How many steps the detour cost.")


class CriticalPath(BaseModel):
    """Compressed memory of one run: the shortest path that produced its outcome."""

    outcome: Literal["passed", "failed"]
    entry_points: list[EntryPoint] = Field(default_factory=list)
    critical_path: list[CriticalStep] = Field(default_factory=list)
    detours: list[Detour] = Field(default_factory=list)
    pitfalls: list[str] = Field(default_factory=list)
    terminal_condition: str = Field(description="How the run ended, e.g. 'stopped at payment approval'.")
    first_unmet_requirement: Optional[str] = Field(
        default=None, description="For failed runs: the first requirement the run did not satisfy."
    )

    def clamped(self) -> "CriticalPath":
        """Enforce the size caps the prompt asks for, without failing on a slightly long output."""
        return CriticalPath(
            outcome=self.outcome,
            entry_points=[
                EntryPoint(tool=_clip(e.tool, 80), start_url=_clip(e.start_url, 400) if e.start_url else None)
                for e in self.entry_points[:MAX_STEPS]
            ],
            critical_path=[
                CriticalStep(step=i, tool=_clip(s.tool, 80), action=_clip(s.action), result=_clip(s.result))
                for i, s in enumerate(self.critical_path[:MAX_STEPS], start=1)
            ],
            detours=[
                Detour(
                    tried=_clip(d.tried), why_it_failed=_clip(d.why_it_failed), steps_wasted=max(0, int(d.steps_wasted))
                )
                for d in self.detours[:MAX_DETOURS]
            ],
            pitfalls=[_clip(p) for p in self.pitfalls[:MAX_PITFALLS] if str(p).strip()],
            terminal_condition=_clip(self.terminal_condition),
            first_unmet_requirement=_clip(self.first_unmet_requirement) if self.first_unmet_requirement else None,
        )


@dataclass(frozen=True)
class TranscriptRow:
    index: int
    role: str
    tool: Optional[str]
    status: Optional[str]
    title: Optional[str]
    text: str
    url: Optional[str] = None
    calls: tuple[dict[str, Any], ...] = ()

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"i": self.index, "role": self.role}
        if self.tool:
            out["tool"] = self.tool
        if self.status:
            out["status"] = self.status
        if self.title:
            out["title"] = self.title
        if self.text:
            out["text"] = self.text
        if self.url:
            out["url"] = self.url
        if self.calls:
            out["calls"] = list(self.calls)
        return out


@dataclass
class Transcript:
    root_agent_id: str
    goal: str
    outcome: Literal["passed", "failed"]
    outcome_note: str = ""
    benchmark_task_name: Optional[str] = None
    rows: list[TranscriptRow] = field(default_factory=list)
    tool_inventory: tuple[str, ...] = ()
    total_rows: int = 0
    dropped_rows: int = 0

    def to_prompt_payload(self) -> dict[str, Any]:
        return {
            "goal": self.goal,
            "outcome": self.outcome,
            "outcome_note": self.outcome_note,
            "rows_shown": len(self.rows),
            "rows_total": self.total_rows,
            "tool_inventory": list(self.tool_inventory),
            "transcript": [row.to_dict() for row in self.rows],
        }


@dataclass
class MemoryHit:
    id: str
    goal: str
    benchmark_task_name: Optional[str]
    passed: Optional[bool]
    root_status: Optional[str]
    created_at: Optional[str]
    similarity: float
    critical_path: Optional[CriticalPath]
    compressed_now: bool = False
    features: dict[str, float] = field(default_factory=dict)

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "task": self.benchmark_task_name,
            "passed": self.passed,
            "similarity": round(self.similarity, 4),
            "has_critical_path": self.critical_path is not None,
            "compressed_now": self.compressed_now,
            "features": {k: round(v, 4) for k, v in self.features.items()},
        }
