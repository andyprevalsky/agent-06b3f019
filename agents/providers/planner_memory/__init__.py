"""Planner memory: trajectory RAG over finalized runs for the planner LLM.

Pipeline (see docs in each module):

    R2 bundle ──extract──► transcript ──compress (once, cached)──► CriticalPath
    Postgres PlannerMemory rows (written + embedded at archive finalize)
    goal ──backend embed + pgvector cosine──► candidates (goal vectors)
    candidates ──judge LLM (same task?)──► at most one hit
    hits ──render──► native get_memories fork (assistant tool_call + tool result)
"""

from providers.planner_memory.compressor import (
    COMPRESSOR_PROMPT,
    COMPRESSOR_PROMPT_MAX_LINES,
    COMPRESSOR_VERSION,
    compress_transcript,
)
from providers.planner_memory.inject import (
    GET_MEMORIES_TOOL,
    GET_MEMORIES_TOOL_NAME,
    MemoryFork,
    build_memory_fork,
    insert_memory_fork,
    planner_context_tools,
    render_memories,
)
from providers.planner_memory.records import CriticalPath, MemoryHit, Transcript, TranscriptRow
from providers.planner_memory.retrieval import (
    JudgeVerdict,
    MemoryRetrieval,
    RetrievalConfig,
    apply_verdict,
    planner_memory_available,
    retrieve_memories,
    shortlist,
)
from providers.planner_memory.transcript import build_transcript, load_bundle_transcript, trim_rows

__all__ = [
    "COMPRESSOR_PROMPT",
    "COMPRESSOR_PROMPT_MAX_LINES",
    "COMPRESSOR_VERSION",
    "CriticalPath",
    "GET_MEMORIES_TOOL",
    "GET_MEMORIES_TOOL_NAME",
    "MemoryFork",
    "JudgeVerdict",
    "MemoryHit",
    "MemoryRetrieval",
    "RetrievalConfig",
    "Transcript",
    "TranscriptRow",
    "build_memory_fork",
    "build_transcript",
    "compress_transcript",
    "insert_memory_fork",
    "planner_context_tools",
    "load_bundle_transcript",
    "planner_memory_available",
    "apply_verdict",
    "render_memories",
    "retrieve_memories",
    "shortlist",
    "trim_rows",
]
