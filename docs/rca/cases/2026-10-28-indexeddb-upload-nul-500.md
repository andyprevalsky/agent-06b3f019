---
id: 2026-10-28-indexeddb-upload-nul-500
date: 2026-10-28
title: IndexedDB uploads holding a NUL character 500ed every sync batch, so that user's IndexedDB data stopped syncing
surface: back-end
component: integrations-indexeddb-upload
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/integrations/repo.indexeddbUpload.ts bindUploadDocument — bound the raw JSON text as $1::jsonb; jsonb cannot hold U+0000, and this path skipped the NUL strip the cookie/localStorage uploads already apply
symptoms:
  - "unsupported Unicode escape sequence"
  - "\\u0000 cannot be converted to text"
  - "POST /api/integrations/indexedDB/upload -> 500"
  - "invalid byte sequence for encoding \"UTF8\": 0x00"
tags:
  - integrations
  - indexeddb
  - mac-sync
  - postgres
  - scale-100-seats
sources:
  - task S29 (prod Render logs, IndexedDB upload 22P05)
  - commit ffa4080c8 (reproduced on origin/main)
repro: back-end/src/tests/blackbox/integrations.browser-uploads-1.cases.ts
status: fixed
---

## Problem

`POST /api/integrations/indexedDB/upload` failed with Prisma `$executeRawUnsafe`
22P05 "unsupported Unicode escape sequence … \u0000 cannot be converted to
text", about every 5 minutes.

- **Start:** the earliest 22P05 within Render's 30-day log window is
  2026-10-15 01:30:43Z, and the errors were still occurring on 2026-10-28.
- **Who:** the only user with an active Mac browser sync in the window is
  1f85ff25 (LocalStorage written within the last hour). Their IndexedDB rows
  last changed on 2026-10-22, while the failing batch kept repeating.
- **Effect:** the batch holding the NUL-bearing origin never synced, so agents
  never got that site's current IndexedDB state.

## Diagnosis

Critical path: Mac uploader → `routes.browser.ts` IndexedDB handler →
`decryptCompressedToUtf8` → `ingestIndexedDBUploadJson` →
`bindUploadDocument`, which runs `INSERT … VALUES ($1::jsonb)`.

- The 2026-08-12 OOM fix deliberately never parses the document in Node; it
  binds the raw JSON text straight into jsonb.
- Postgres text and jsonb cannot hold U+0000. A JSON `\u0000` escape fails the
  jsonb cast (22P05). A raw NUL fails the text bind (22021).
- The cookie and localStorage uploads parse JSON and already strip NUL
  (`sanitizeString` / `sanitizeStringFull`). The IndexedDB path lost that step
  when it moved to raw text.

**Local repro:** the new blackbox case uploads an origin whose IndexedDB
records hold an escaped NUL, a raw NUL and a literal backslash-u0000 text. On
origin/main it returns 500 (22021). With the fix it returns 200, 5 of 5 runs.

## Solution

`stripNulFromJsonText` runs before the jsonb bind:

- It drops raw NUL characters.
- It drops `\u0000` escapes preceded by an even run of backslashes, so a
  literal `\\u0000` (an escaped backslash followed by text) is preserved.
- It is a no-op unless the text contains either form, and it never parses the
  document, so the OOM guard holds.
- NUL is dropped exactly like the cookie and localStorage uploads already do.
- The client-computed `hashes` are not touched, so skip-unchanged behaviour is
  unchanged. The regression asserts that a same-hash re-upload leaves
  `updatedAt` unchanged.

**Regression:** `testIndexedDBUpload_nulCharactersStripped`, in the backend
`integrations` blackbox domain (registry-parallel-3; the registration count and
hash are updated). It asserts a 200, the stored content (NUL removed, literal
text kept), the stored client hash, and the same-hash no-op.

**Scale (10k agents):** one string scan per upload, linear in payload size,
and only replacing when a NUL is present. There are no extra queries.

## Human feedback

The parent (S29) asked to strip or escape NUL consistently across the
LocalStorage, IndexedDB and cookie uploads while keeping hash-based
skip-unchanged stable.

## Reusable lesson

When a hot path is rewritten to avoid parsing (for memory or speed), carry
over every sanitizer the parsed path applied. Postgres-hostile code points
(U+0000) must be removed on every ingest path, not only on the ones that
happen to parse.
