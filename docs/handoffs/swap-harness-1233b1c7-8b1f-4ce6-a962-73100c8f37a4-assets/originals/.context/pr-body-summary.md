## Summary

Prod agent `07281fc3-5e49-4cd2-9573-235cb19b0481` failed 8 browser spawns on 2026-10-12 with `Browser session init failed after 5 transient-proxy retries: {"error":"Browser state injection timed out after 18000ms"}`. Render logs for every google.com init that day show a serial state phase of 15.9–19 s against the 18 s budget:

- **IndexedDB, 9.7–13.5 s:** one 79 MB `https://drive.google.com` row (`ODPMC` `modules`/`cssModules`), which is Drive's cached JS/CSS code. It was restored into an `admin.google.com` session because origin selection is realm-wide.
- **localStorage, 4.4–6.8 s:** 28–38 stored keys. About half are Mac-reader artifacts: `ttps://` duplicates of cloud-harvest rows, and partitioned third-party keys. The old restorer stripped the partition and replayed them as first-party storage (visa.com, youtube.com, … inside a Google session).

Changes:

- **Bound restored origin payloads.** Skip an origin whose payload exceeds 8 MiB of sent bytes (`BROWSER_STATE_ORIGIN_PAYLOAD_MAX_BYTES`). The existing staging statement checks the O(1) `pg_column_size` first, so an oversized row is never serialized, then checks the exact staged length. No extra round trip. Skips log table and byte counts at warn (no origin, since origins are browsing history). Restored counts stay truthful. Prod's only rows over 2.3 MB are three Drive module caches (79, 79, 37 MB).
- **Decode stored localStorage keys once at restore.**
  - Repair only the Mac reader's dropped `h`.
  - Skip partitioned, extension and internal keys.
  - Restore each origin's rows oldest-first in a single visit, so the newer value of a shared key wins and duplicate rows no longer cost extra navigations.
  - The reader itself is not changed here: canonical Mac keys would collide with cloud-harvest rows in a table with no source column. That follow-up is recorded in the RCA case.

## Reproduction

- **Real production init path.** `initSession` against a real Kernel browser (SF residential proxy), local user seeded with the prod realm shape (real origin keys and sizes, synthetic values):
  - main: 3/3 `BrowserStateInjectionTimeout: Browser state injection timed out after 18000ms`
  - fix: 3/3 OK, state phase 12.4–13.5 s from a dev box with about 2× Render's per-origin latency.
- **Permanent regression.** `verifyRealmRestoreBudget` in `browser-origin-payload.blackbox.ts` runs real Postgres and real `injectUserData` against the prod realm shape. On the old source it fails with `over-budget origin reached the browser: 27404739 bytes`. With the cache assertion removed, it fails with `partitioned third-party storage was replayed first-party`. With the fix it passes.
- **RCA archive.** Recurrence appended to `2026-09-30-browser-origin-injection-materialized-jsonb` (its open 18 s attribution); new case `2026-10-12-mac-localstorage-reader-dropped-storage-key-first-byte`.

**10k-agent behavior:** per-init work drops, with no shared state, lock, or per-user fan-in. Each init does at most one extra scalar per origin inside the existing staging statement.
