---
description: "Audit providers/ and utils/ for boundary violations, misplaced files, duplicated logic, and orphaned types. Fix everything mechanically."
---

# Audit Providers and Utils

Scan the entire source tree to enforce clean boundaries between providers, utils, and domains. This skill ensures the cross-cutting infrastructure is correctly organized before (or after) domain refactoring.

Read `.context/attachments/pasted_text_2026-04-05_20-13-11.txt` for the foundational thinking. Key insight: "Technical debt is like a high-interest loan: it's almost always better to pay it down continuously."

Run this skill:
- **Before the first `/refactor-domain-for-full-autonomy`** — ensures the foundation is solid
- **After refactoring multiple domains** — catches drift, deduplication opportunities, and boundary violations introduced during refactoring
- **Periodically as a "garbage collection" pass**

**This is a loop. Do NOT stop after partial work. Continue until all violations are fixed and all tests pass.**

## Step 0: Verify required scripts

```bash
find . -maxdepth 3 -name 'map-domains.*' -o -name 'map_domains.*' | grep -v node_modules | grep -v __pycache__
```

**If no domain mapping script is found:** Run `/map-domains` first. It will analyze the codebase and write the mapping script.

Optionally check for structural tests (recommended but not required):

```bash
find . -maxdepth 5 -path '*/tests/structural/*' -name 'layer-deps.*' | grep -v node_modules | grep -v __pycache__
```

## The rules

These are the non-negotiable boundaries from the layered architecture:

```
utils/        → imports NOTHING from the project source tree (pure functions, zero side effects)
providers/    → imports from utils/ and external packages ONLY (never from domains/)
domains/*/    → imports from providers/, utils/ (runtime layer only), own domain layers
```

### What belongs where

**providers/** — Any module with side effects:
- I/O (DB queries, HTTP calls, file system, WebSocket, message queues)
- External service wrappers (any third-party API client)
- Auth middleware (reads headers, verifies tokens, sets request state)
- Logging (writes to stdout/stderr)
- Anything that reads environment variables

**utils/** — Pure functions with zero side effects:
- String formatting, truncation, template rendering
- Data transformation (no I/O to get the data)
- Constants, enums, type mappings (that don't read env vars)
- Error class definitions
- Functions you could copy-paste into any project and they'd work

**The test:** If you can run the function in a unit test with no mocks, no env vars, no network — it's a util. Everything else is a provider.

## Step 1: Inventory

Scan the full source tree and build an inventory of all files in providers/, utils/, and any legacy shared directories (lib/, middleware/, helpers/, common/):

```bash
find <source-root>/providers <source-root>/utils <source-root>/lib <source-root>/middleware <source-root>/helpers <source-root>/common -type f -name '*.<ext>' 2>/dev/null | sort
```

For each file, read it and classify:
- **Side effects?** (DB, HTTP, file I/O, env reads, stdout) → provider
- **Pure function?** (deterministic input→output, no I/O) → util
- **Type definitions only?** → belongs with the provider or domain that owns the concept

Record the classification in a table.

## Step 2: Detect misplaced files

### 2a. Pure functions in providers/

Scan every file in providers/ for files that have **zero side effects**. These are misplaced and should move to utils/.

Common indicators:
- File contains only exports with no imports from I/O packages
- No imports of: database client, `fetch`/`httpx`/`requests`, `fs`/`os.path`, `process.env`/`os.environ`, logging
- Functions are pure transformations: input → output, constants

### 2b. Side effects in utils/

Scan every file in utils/ for files that have side effects. These are misplaced and should move to providers/.

### 2c. Providers importing from domains/

Search all provider and util files for imports from domains/. Any match is a boundary violation.

### 2d. Utils importing from project source

Search all util files for imports going up to the project source. Utils must be self-contained.

### 2e. Standalone types directory

If a standalone types directory exists, every file in it needs to be rehomed:
- Types used by a single provider → move into that provider file
- Types used by multiple providers → shared types export within providers/
- Types used only by domains → move into the domain's types layer
- Ambient type declarations (`.d.ts`, `py.typed`, etc.) → keep in place (language-level, not architectural)

## Step 3: Detect duplicated logic across entry files

Scan all domain entry files (routes, handlers, tools) for repeated patterns that should be extracted to providers.

### Patterns to look for:

**3a. Duplicated data access** — Same query pattern in 2+ files
**3b. Duplicated error handling** — Same try/catch → status code mapping
**3c. Duplicated validation** — Same schema or manual validation in multiple files
**3d. Duplicated auth patterns** — Same post-auth logic in multiple files
**3e. Inline utility functions** — Helper functions defined inside entry files that are generic enough to be shared

For each duplicate found, record:
- The pattern
- Which files contain it
- Where it should live (which provider, or new provider, or util)

## Step 4: Fix misplaced files

For each misplaced file identified in Step 2:

1. Move the file to the correct directory
2. Find ALL importers across the codebase
3. Update every import to point to the new location
4. Verify: run the type checker / compiler with 0 errors

## Step 5: Extract duplicated logic

For each significant duplication found in Step 3:

1. **Identify the right home:**
   - Data access patterns → will become repo layer during domain refactoring (note it, don't extract yet if domain isn't refactored)
   - Cross-domain shared logic → extract to a provider
   - Pure utility functions → extract to utils

2. **For cross-domain shared logic being extracted to a provider:**
   - Create or extend the appropriate provider file
   - Export the shared function
   - Replace inline usage in each file with an import
   - Ensure the function signature is framework-agnostic (no request/response args)

3. **Don't over-extract:**
   - If a pattern appears in only 1-2 files and will be extracted to the repo layer during refactoring, leave it
   - Only extract NOW if: used by 3+ files AND not domain-specific AND the extraction is clearly simpler than the duplication

## Step 6: Consolidate orphaned types

If a standalone types directory exists, move each file to its proper owner. After moving, update all imports. Delete the types directory if only ambient declarations remain.

## Step 7: Verify

### 7a. Type check / compile
Must complete with 0 errors.

### 7b. Structural tests (if they exist)
Must pass for all existing domains.

### 7c. Boundary verification
Search for boundary violations:
- No provider imports from domains/
- No util imports from the project source tree

Both must return 0 results.

### 7d. Linter
Run the linter on all provider and util files.

### 7e. Blackbox tests
Full suite must pass — provider/util moves can break imports that affect any domain.

## Step 8: Report

Output:
- **Inventory table:** every file in providers/, utils/ with classification
- **Misplaced files found and fixed** (moved from → to)
- **Boundary violations found and fixed**
- **Duplicated patterns found:**
  - Extracted now (to which provider/util)
  - Deferred to domain refactoring (with note of which domain)
- **Orphaned types consolidated** (moved from types/ to which provider/domain)
- **Test results:** type check, structural, linter, blackbox

Only say **`Audit complete`** if ALL of:
- [ ] Zero misplaced files remain (all files classified correctly)
- [ ] Zero boundary violations (providers don't import domains, utils don't import project source)
- [ ] Orphaned types consolidated (except ambient declarations)
- [ ] Type check passes with 0 errors
- [ ] Structural tests pass (if they exist)
- [ ] Linter passes on providers/ and utils/
- [ ] Blackbox tests pass
