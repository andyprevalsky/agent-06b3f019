---
id: 2026-09-29-output-modality-contract-lost-across-schema-and-rendering
date: 2026-09-29
title: Large structured agent output was forced inline and stringified as objects
surface: cross
component: response-schema-generation-and-structured-response-display
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/src/features/terminal-component-group/components/StructuredResponseDisplay.tsx FieldValue passed arrays of objects to formatPrimitive and Array.join
symptoms:
  - "Items (list[object])" followed by repeated "[object Object]" in Extracted Output
  - Agent generated large inline items despite producing CSV and Markdown files
tags:
  - response-schema
  - output-modality
  - structured-output
  - file-pointer
sources:
  - agent a890a362-9775-410c-beb0-c251cd511845
repro: front-end/src/tests/blackbox/structured-response-display.blackbox.tsx
status: fixed
---

## Problem

The attached screenshot of agent `a890a362-9775-410c-beb0-c251cd511845` shows `Extracted Output` with `Items (list[object])` rendered as repeated `[object Object]`. The read-only production message trace in `.context/rca-agent-a890-messages.txt` confirms a child was instructed to return `items (list[object], required)`. The same run produced CSV and Markdown files, but the item schema still required a bulky inline array. The captured user goal in `.context/rca-agent-a890-goal.txt` asked for an open-ended inventory with links, photos, and prices for marketplace listings.

The owning frontend blackbox test failed before the fix: `./node_modules/.bin/vitest run src/tests/blackbox/structured-response-display.blackbox.tsx src/tests/blackbox/agent-settings-dialog.blackbox.tsx` could not find the first item name in the rendered output and observed `[object Object]`. A live call through the production Python schema generator against the captured goal initially emitted `amazon_items` and `non_amazon_items` as `list[object]` (`.context/schema-gen-live-test.txt`).

## Diagnosis

The first visible bad boundary was `FieldValue` passing an array of objects to `formatPrimitive`, which called `Array.join(', ')`; JavaScript converted each object to `[object Object]`. This renderer defect affected any valid inline object list. Independently, schema generation selected inline `list[object]` for this open-ended, multi-attribute collection where a file would be more usable. Code-child and browser completion shortcuts also checked nonempty values without enforcing new size and nullability metadata, creating a second contract gap when those constraints were added.

The prompt-edit climb started at **large inventories selected inline without considering their size or reuse**. Its next-deeper class, **output medium is not planned from expected volume and use across goal-to-schema paths**, is coherent, so that is the stopped class and the level implemented in the Python, backend, and tool-declared schema paths. The next rung, **all presentation-medium choices across all output types need one planner rule**, fails to be coherent in this schema generator: scalar answers, short comparisons, images, and generated files have different verification and artifact contracts, and no single medium rule captures them. The implemented rule uses expected record volume and reuse needs, independent of incident-specific product names or sites. This is an owned schema-planning contract defect, not evidence that the model is intrinsically unable to choose files.

Archive searches run before diagnosis: `python3 scripts/rca_archive.py search '[object Object] Extracted Output'`, `python3 scripts/rca_archive.py search 'array of objects displayed as strings in frontend'`, and `grep -RIlF '[object Object]' docs/rca/cases`. No case matched this first bad boundary; this incident is novel in the archive.

## Solution

`StructuredResponseDisplay` renders structured arrays and objects as readable JSON while retaining file chips for file pointers. Python and backend schema-generation prompts now default open-ended multi-record deliverables to a file even when the user merely says “list”; short bounded comparisons remain inline. Agent tool-declared schemas get the same guidance. API, tool, verifier, child fast path, browser shortcut, and frontend schema display carry and enforce `minItems`, `maxItems`, `minLength`, `maxLength`, and optional `required: false` keys at the top and nested levels; equal bounds represent exact size, including zero. Legacy `nullable` remains separately supported for an explicit JSON null value. The unrelated Agent ID copy request is covered by its own frontend blackbox test.

The unchanged frontend blackbox command passed after the fix (2 files, 16 tests). The production Python generator called with the captured goal emitted a required `amazon_items_file: file_pointer` plus two scalar quote fields (`.context/schema-gen-proof-a890.json`); its opt-in live test passed within the `llm` suite (215 tests). An independent backend generator call emitted a single required `inventory_file: file_pointer` and passed its file-output assertion (`.context/backend-schema-gen-proof-a890-pass.json` and `.context/backend-schema-gen-live-test-pass.txt`). An earlier backend sample emitted an `amazon_inventory_file: file_pointer` plus a short inline quote list; that sample's overly broad assertion rejected the short list, and a subsequent provider attempt ended without model output. The backend agents blackbox suite passed, and Python `llm`, `tool-schemas`, and `spawn-claude-code-agent` domains passed. A new code-child shortcut repro failed before its fix and passed unchanged afterward. These checks prove new schema generation and contract handling for the captured goal; they do not mutate the historical agent or claim that its old persisted schema has been regenerated. The prompts ask for volume-aware file selection; model behavior on other goals and large traffic volumes was not measured. The opt-in live generator test does not run in unfunded default CI, so file-preference regression detection there remains a limitation. At 10,000 agents, schema generation still makes one call per agent, validation scans only that agent's output fields and records, and rendering touches only the opened result; the change adds no shared channel, lock, query, or polling loop.

After the user's optional-key clarification, the final Python generator emitted required `items_file: file_pointer` plus three `required: false` integer counts for the same captured goal (`.context/schema-gen-proof-a890-optional-final.json`). A backend live sample emitted required `apartment_inventory_file: file_pointer` plus optional `total_items_listed: int` (`.context/backend-schema-gen-proof-a890-optional.json`); a later backend attempt hit intermittent Cerebras empty-stream errors and produced no schema. Focused verifier, browser, code-child, tool-schema, API, and frontend tests cover omission and validation of present optional fields.

After code review tightened the backend's strict JSON schema, two more live backend samples of the captured goal completed: one chose `marketplace_listing_file: file_pointer`, and one chose an inline `items: list[object]` (`.context/backend-schema-gen-proof-a890-post-review-1.json` and `.context/backend-schema-gen-proof-a890-post-review.json`). A third attempt ended with repeated Cerebras empty streams. File selection is therefore a model preference, not a deterministic guarantee; the historical agent output remains unchanged.

## Human feedback

The user explicitly requested `/rca`, output size constraints, preference for file output on large results, proof against agent `a890a362-9775-410c-beb0-c251cd511845`, and a button copying `agent-id: <{agent_id}>`. They clarified that “nullable” meant an optional key the agent may omit, including integer fields, so the generated contract uses `required: false` for omission and retains `nullable` only as a distinct legacy null-value capability.

## Reusable lesson

When an agent delivers an open-ended structured collection, verify the schema's output medium and the renderer's treatment of object arrays at their owning boundaries.
