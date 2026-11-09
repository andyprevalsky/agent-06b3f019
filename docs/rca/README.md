# RCA case archive

Every completed `/RCA` leaves a record here: **problem → diagnosis → solution →
human feedback**. The archive is checked into git so it survives context
windows, workspaces, and agent sessions.

It exists for one reason: **a bug we have already root-caused should be
recognized in seconds, not re-diagnosed from scratch.** Roughly half of this
repo's incidents are repeats of a known failure class in a new costume — a
migration that never shipped, a fixture that drifted, a timeout blamed for a
stall that was really a block, a "third-party outage" that was our own retry
window. Searching this archive first turns a 40-minute investigation into a
one-line confirmation, and — just as importantly — stops `/RCA` from re-proposing
a fix the human already rejected.

```
docs/rca/
  README.md            this contract
  INDEX.md             generated, greppable — one entry per case
  cases/*.md           one file per root-caused incident
  process-feedback.md  durable human rules about HOW to do RCA here
```

## Using it (what `/RCA` does)

**Before forming any hypothesis**, after gathering runtime evidence:

```bash
python3 scripts/rca_archive.py search "prisma migration prod 500 column does not exist"
python3 scripts/rca_archive.py show 2026-07-06-loose-sql-ignored-by-migrate-deploy
```

Search ranks by tag, title, symptom, then full text, and prints each hit's
reusable lesson. Plain `grep -ri "<error string>" docs/rca/` works too, and is
the right move when you have an exact error string.

A hit is a **lead, not a verdict.** The hard gate still applies: you owe a local
repro that fails and a fix that makes it pass. A prior case tells you where to
point the flashlight and which fixes were already rejected — it never
substitutes for evidence.

**After the RCA lands**, write the case:

```bash
python3 scripts/rca_archive.py new loose-sql-ignored-by-migrate-deploy
$EDITOR docs/rca/cases/<date>-loose-sql-ignored-by-migrate-deploy.md
python3 scripts/rca_archive.py reindex
python3 scripts/rca_archive.py validate
```

## The case format

Frontmatter is a constrained dialect (scalars and ` -` lists only) so it stays
parseable by python, the node structural test, and plain grep alike. Full field
rules live in the validator: `scripts/rca_archive.py`.

| field                | meaning                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | must equal the filename stem: `<YYYY-MM-DD>-<slug-naming-the-cause>`                                                                  |
| `date`               | when the incident was root-caused                                                                                                     |
| `surface`            | `back-end`, `front-end`, `agents`, `mac-app`, `infra`, `harness`, `cross`                                                             |
| `component`          | narrowest owning module (`prisma-migrations`, `rose-client`, …)                                                                       |
| `classification`     | Step 4 class from `/RCA` **Classify** (`.claude/commands/rca.md`); use `unresolved` only for an open case without enough proof to select a causal bucket |
| `problem_class`      | Step 5a problem bucket — the generalizable class, not the instance                                                                    |
| `first_bad_boundary` | where data first went wrong; for an open case, state the earliest observed candidate and that causality is unproven                   |
| `symptoms`           | the literal strings a future engineer would grep for — **the primary search surface**                                                 |
| `tags`               | lowercase kebab keywords: technology + failure mode                                                                                   |
| `sources`            | provenance: `PR #N`, `commit <sha>`, `memory:<name>`, `plan:<path>`, `agent <uuid>`, `fleet run <id>`                                 |
| `repro`              | the checked-in test that fails pre-fix and passes post-fix, or `none-recorded`                                                        |
| `status`             | `fixed`, `open`, `mitigated`, `wontfix`, `superseded`                                                                                 |

Use `classification: undetermined` or `classification: unresolved` when the evidence does not yet establish a
Step 4 cause. It is valid only for `status: open`; resolving or mitigating a case
requires an evidence-backed classification. Describe the remaining causal proof
in **Diagnosis** rather than assigning blame or model limitations prematurely.

Five required sections:

- **Problem** — observed wrong behavior + the runtime evidence that proved it.
- **Diagnosis** — causal chain to the first-bad boundary, then the deepest
  _owned_ cause (Step 5a). Say what made the failure _possible_. When the
  intended fix is a prompt edit, also record the Step 5b climb: the class you
  stopped at, the next-deeper class you tried, and why the more general
  solution failed to be coherent.
- **Solution** — the generalizable fix, where it landed, which sibling failures
  it also prevents.
- **Human feedback** — what the human corrected, rejected, or insisted on.
  `None recorded.` if there was none. **Never invent it.** This section is why
  the archive beats a git log: git records what we did, this records what we
  were told to do differently.
- **Reusable lesson** — one imperative sentence. This is what search prints.

## Rules

1. **One incident per file.** A PR fixing three unrelated defects is three cases.
2. **Only what the source supports.** No invented log lines, paths, or metrics.
   `not recorded in the source` is an acceptable and honest phrase.
3. **Name the cause, not the symptom, in the slug.**
   `loose-sql-ignored-by-migrate-deploy`, not `prod-500`.
4. **Never delete a case.** If a later RCA supersedes it, set
   `status: superseded` and `superseded_by: <id>`. A wrong-but-believed
   diagnosis is itself a lesson.
5. **A repeat is not a new case.** If the same cause recurs, append the new
   evidence and source to the existing case rather than forking it — recurrence
   count is the signal that a fix did not hold.

`back-end/src/tests/structural/rca-archive.test.ts` enforces the schema, section
completeness, and `INDEX.md` freshness on every deploy.

## Historical backfill provenance

The 2026-07-29 backfill enumerated all 839 local Claude transcript files (37
actual `/RCA` command expansions across 20 sessions), all 800 merged pull
requests through PR #916, the repository's git history, and 72 persistent
project-memory topics. It distilled those overlapping sources into 270 distinct,
source-supported incidents. Pure features, refactors, dependency/version bumps,
and records without a diagnosed cause were deliberately excluded.

The source transcripts remain local because they contain unrelated private
context. Each checked-in case carries only the incident facts and its auditable
`sources` entries. The structural test pins 270 as the minimum historical floor;
the archive may grow, but it must never silently shrink.
