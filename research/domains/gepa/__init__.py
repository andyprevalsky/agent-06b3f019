"""GEPA domain — layered facade over research.gepa.

This package organises the four GEPA pipelines (run, run_full_pipeline,
run_judge, smoke_optimizer) behind a strict five-layer interface:

    types   — dataclasses and schemas
    config  — constants, defaults, paths
    repo    — file I/O (preference labels, clarified tasks, embeddings cache)
    service — business logic (scoring, critic, evaluators, optimisation)
    runtime — per-pipeline entry points

The underlying implementations still live under ``research.gepa.*`` so that
existing test modules continue to resolve. New callers should import from
``research.domains.gepa`` exclusively.
"""
