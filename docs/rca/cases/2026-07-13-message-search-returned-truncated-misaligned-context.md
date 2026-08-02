---
id: 2026-07-13-message-search-returned-truncated-misaligned-context
date: 2026-07-13
title: Message search returned truncated, misaligned fragments with no deterministic neighboring records
surface: back-end
component: message-search
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: message-search result assembly — matches were truncated and returned without deterministic chronological neighbors
symptoms:
  - message search results are truncated mid-content
  - search hits are returned out of chronological order or misaligned with their thread
  - neighboring messages around a hit are missing or non-deterministic
tags:
  - message-search
  - data-grep
  - truncation
  - ordering
  - context-quality
sources:
  - PR #764
repro: none-recorded
status: fixed
---

## Problem

Searching messages produced fragments that were truncated and misaligned: a hit
did not reliably come back with its surrounding records, and the ordering of what
was returned was not deterministic. An agent reading that output could not
reconstruct what was actually said around the match.

## Diagnosis

The result assembler truncated matched content and returned hits without a
deterministic set of neighboring records, so the search output was neither
complete for a single match nor chronologically coherent across matches. This is
a context-fidelity defect rather than a retrieval defect — the right rows were
found, but what reached the model was a lossy, order-unstable projection of them,
which is exactly the failure mode that aggressive truncation of context flows
produces.

## Solution

Message search now preserves chronological, aligned context with deterministic
neighboring records around each hit. Targeted data-grep regression coverage was
added to the durable suite alongside the other SMS-path fixes in the same PR, so a
future change that re-introduces truncation or unstable ordering fails a test
rather than quietly degrading agent context.

## Human feedback

The same PR codified RCA local-repro and post-fix verification requirements for
this class of fix.

## Reusable lesson

Search results feeding an LLM must be chronologically aligned, deterministic, and
untruncated — a lossy projection of the right rows is still wrong context.
