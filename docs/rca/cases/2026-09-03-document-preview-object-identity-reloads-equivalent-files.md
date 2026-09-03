---
id: 2026-09-03-document-preview-object-identity-reloads-equivalent-files
date: 2026-09-03
title: Equivalent FilePointer objects repeatedly reloaded open previews
surface: front-end
component: document-preview-loader
classification: our-bug
problem_class: other
first_bad_boundary: front-end/src/features/terminal-component-group/components/useDocumentPreview.ts useDocumentPreview effect dependencies
symptoms:
  - File output constantly refreshes
  - Opening the drawer resets my scroll position
  - expected "vi.fn()" to be called 2 times, but got 4 times
tags:
  - document-preview
  - react-effects
  - file-pointer
  - scroll-reset
  - polling
sources:
  - commit 1947f6c5bebdf257681df8820f80175e2914475e
repro: front-end/src/tests/blackbox/completion-summary-documents.blackbox.tsx
status: fixed
---

## Problem

The human reported that both inline file output and the right-side document
drawer constantly refreshed. Each refresh replaced the rendered document, so
the browser reset the reader's scroll position and made the output unreadable.

The local blackbox reproduced the runtime boundary by rendering an HTML output,
opening its drawer, and then reconciling an equivalent freshly allocated
`FilePointer`, as the agent-detail API does. Before the fix, the unchanged test
failed with `expected "vi.fn()" to be called 2 times, but got 4 times`: both the
inline preview and drawer downloaded the same file again, and the drawer's
original iframe was replaced.

## Diagnosis

Agent-detail reconciliation installs freshly deserialized `Message` and
`FilePointer` objects in `applyAgentBackfill`. The disconnected fallback can do
that every two seconds. `FilePointerDisplay` sends the pointer to two
`useDocumentPreview` instances: one for the inline preview and one for the open
drawer.

At the first bad boundary, `useDocumentPreview` listed the complete `file`
object in its effect dependencies. React therefore treated an equivalent API
object as a new resource, changed the preview to `loading`, aborted and cleaned
up the old load, and downloaded the unchanged file again. The loading state
unmounted the iframe or table; the new ready state constructed another one at
scroll position zero. `DocumentPreviewDrawer` also keyed its selected-sheet
reset to the `file` object, so equivalent polling snapshots could return a
spreadsheet to its first sheet.

The deepest owned cause was the absence of a stable semantic resource-version
invariant: a persisted file's referential identity was incorrectly used to
decide when its contents and viewer state had changed. None of the specific
problem buckets (timeouts, contracts, preferences, capabilities, concurrency,
fixtures, observability, or model intelligence) describes this UI lifecycle
defect, so it is classified as `other`; a useful future bucket would be
`unstable-ui-resource-identity`.

## Solution

`useDocumentPreview.ts` now derives a semantic key from all persisted
`FilePointer` fields and keeps the latest pointer in a ref. Its loading effect
runs only when the preview is enabled, the selected sheet changes, or actual
file data changes. `DocumentPreviewDrawer.tsx` uses the same key when deciding
whether to reset selected-sheet state. Closing and reopening a drawer still
reloads it, and changed file metadata still creates a new resource and performs
the existing object-URL cleanup.

The blackbox keeps both preview instances active, rerenders with `{ ...file }`,
and asserts that downloads stay at two and the drawer keeps its original iframe
node. The shared loader also prevents equivalent-object remounts for PDF,
image, Markdown, text, CSV, XLSX, Numbers, DOCX, and PPTX previews. At 10k-agent
scale, each preview computes one constant-size six-field key per render and
avoids two network reads, content parses, and DOM replacements per equivalent
reconciliation; it adds no shared state or polling.

## Human feedback

The human explicitly reported both inline file-output refreshes and drawer
refreshes, emphasized that losing the scroll position made files unreadable,
and requested both root-cause analysis and a fix.

## Reusable lesson

Key long-lived UI resource effects and viewer state by stable semantic version
fields, never by freshly deserialized object identity.
