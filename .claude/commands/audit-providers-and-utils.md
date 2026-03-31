---
description: "Audit providers/ and utils/ for boundary violations, misplaced files, duplicated logic, and orphaned types. Fix everything mechanically."
---

# Audit Providers and Utils

Scan the entire backend source tree to enforce clean boundaries between providers, utils, and domains. This skill ensures the cross-cutting infrastructure is correctly organized before (or after) domain refactoring.

Run this skill:
- **Before the first `/refactor-domain-for-full-autonomy`** — ensures the foundation is solid
- **After refactoring multiple domains** — catches drift, deduplication opportunities, and boundary violations introduced during refactoring
- **Periodically as a "garbage collection" pass** — the OpenAI harness engineering article calls this out explicitly: "Technical debt is like a high-interest loan: it's almost always better to pay it down continuously"

**This is a loop. Do NOT stop after partial work. Continue until all violations are fixed and all tests pass.**

## The rules

These are the non-negotiable boundaries from the layered architecture:

```
utils/        → imports NOTHING from src/ (pure functions, zero side effects)
providers/    → imports from utils/ and external packages ONLY (never from domains/)
domains/*/    → imports from providers/, utils/asyncHandler (routes only), own domain layers
types/        → SHOULD NOT EXIST as a standalone directory (types belong with their provider or domain)
```

### What belongs where

**providers/** — Any module with side effects:
- I/O (DB queries, HTTP calls, file system, WebSocket)
- External service wrappers (Temporal, Steel, E2B, Supabase, OpenRouter, Twilio)
- Auth middleware (reads headers, verifies tokens, sets request state)
- Logging (writes to stdout/stderr)
- Anything that reads `process.env`

**utils/** — Pure functions with zero side effects:
- String formatting, truncation, template rendering
- Data transformation (no I/O to get the data)
- Constants, enums, type mappings (if they don't read env vars)
- Error class definitions
- Functions you could copy-paste into any project and they'd work

**The test:** If you can run the function in a unit test with no mocks, no env vars, no network — it's a util. Everything else is a provider.

## Step 1: Inventory

Scan the full `src/` tree and build an inventory:

```bash
cd back-end && find src/providers src/utils src/types src/lib src/middleware -type f -name '*.ts' 2>/dev/null | sort
```

For each file, read it and classify:
- **Side effects?** (DB, HTTP, file I/O, env reads, stdout) → provider
- **Pure function?** (deterministic input→output, no I/O) → util
- **Type definitions only?** → belongs with the provider or domain that owns the concept

Record the classification in a table.

## Step 2: Detect misplaced files

### 2a. Pure functions in providers/

Scan every file in `providers/` for files that have **zero side effects**. These are misplaced and should move to `utils/`.

Common indicators of misplaced files:
- File contains only `export const`, `export function`, `export type/interface` with no `import` from I/O packages
- No imports of: `prisma`, `fetch`, `fs`, `process.env`, `supabase`, `openai`, `crypto` (for random), logging
- Functions are pure transformations: string → string, object → object, constants

**Known candidates to check:**
- `providers/roseModels.ts` — if it's just constants and `normalizeRoseAlias()`, it's a util
- `providers/smsTemplates.ts` — if templates are pure string functions, it's a util
- `providers/chat/chatPrompts.ts` — if it's just prompt string constants, it's a util
- `providers/chat/index.ts` — if it's just re-exports, it's a util (re-export files stay where they are though)

### 2b. Side effects in utils/

Scan every file in `utils/` for files that have side effects. These are misplaced and should move to `providers/`.

Check for: `import { prisma }`, `fetch(`, `process.env`, `console.`, `fs.`, `createLogger`.

### 2c. Providers importing from domains/

```bash
cd back-end && grep -rn "from.*domains/" src/providers/ src/utils/ 2>/dev/null
```

Any match is a boundary violation. Providers must never know about domains.

### 2d. Utils importing from src/

```bash
cd back-end && grep -rn "from ['\"]\.\./" src/utils/ 2>/dev/null
```

Any relative import going up to `src/` is a violation. Utils must be self-contained.

### 2e. Standalone types/ directory

If `src/types/` exists, every file in it needs to be rehomed:
- Types used by a single provider → move into that provider file
- Types used by multiple providers → create a shared types export within `providers/` (e.g., `providers/types.ts` or co-locate with the primary provider)
- Types used only by domains → move into the domain's `types.ts`
- Ambient `.d.ts` declarations → keep in `types/` (these are TypeScript-specific, not architectural)

## Step 3: Detect duplicated logic across route files

Scan all `src/routes/*.ts` files (and `src/domains/*/routes.ts` if any exist) for repeated patterns that should be extracted to providers.

### Patterns to look for:

**3a. Duplicated DB queries** — Same Prisma query pattern in 2+ route files:
```bash
cd back-end && grep -rn "prisma\." src/routes/ | sort | uniq -c | sort -rn | head -20
```
If the same `prisma.model.findUnique/findMany/create/update` pattern appears in multiple routes, it should be a provider function.

**3b. Duplicated error handling** — Same try/catch → status code mapping:
Look for repeated patterns like:
- `if (!result) return res.status(404)`
- `catch (error) { res.status(500) }`
- Custom error class checks

If 3+ routes do the same error mapping, extract to a shared error handler in utils.

**3c. Duplicated validation** — Same Zod schema or manual validation in multiple routes:
Look for repeated `req.body` shape checks. These should be extracted to domain `types.ts` files (during refactoring) or to a shared validation provider.

**3d. Duplicated auth patterns** — Same auth + userId extraction pattern:
If many routes do the same `const userId = req.userId` → `if (!userId)` → `return 401` pattern, that's already handled by middleware. But check for routes that duplicate post-auth logic.

**3e. Inline utility functions** — Helper functions defined inside route files that are generic enough to be shared:
```bash
cd back-end && grep -rn "^function \|^const .* = (" src/routes/ | grep -v "router\." | head -30
```

For each duplicate found, record:
- The pattern
- Which files contain it
- Where it should live (which provider, or new provider, or util)

## Step 4: Fix misplaced files

For each misplaced file identified in Step 2:

1. Move the file to the correct directory
2. Update ALL imports across the codebase:
   ```bash
   cd back-end && grep -rn "from.*<old-path>" src/ | grep -v node_modules
   ```
3. Fix every import to point to the new location

### Moving a file checklist:
- [ ] `git mv src/providers/foo.ts src/utils/foo.ts`
- [ ] Find all importers: `grep -rn "from.*providers/foo" src/`
- [ ] Update each import path
- [ ] Verify: `npx tsc --noEmit`

## Step 5: Extract duplicated logic

For each significant duplication found in Step 3:

1. **Identify the right home:**
   - DB query patterns → will become `repo.ts` during domain refactoring (note it, don't extract yet if domain isn't refactored)
   - Cross-domain shared logic → extract to a provider
   - Pure utility functions → extract to utils

2. **For cross-domain shared logic being extracted to a provider:**
   - Create or extend the appropriate provider file
   - Export the shared function
   - Replace inline usage in each route file with an import
   - Ensure the function signature is framework-agnostic (no `req`/`res` args)

3. **Don't over-extract:**
   - If a pattern appears in only 1-2 routes and will be extracted to `repo.ts` during domain refactoring, leave it. Note it as "will be resolved by refactoring."
   - Only extract NOW if: used by 3+ routes AND not domain-specific AND the extraction is clearly simpler than the duplication.

## Step 6: Consolidate orphaned types

For each file in `src/types/`:

1. **Ambient `.d.ts` files** — leave in `types/` (TypeScript declaration files for untyped packages are a language concern, not architectural)
2. **Interface/type files** — find all importers, determine the owning provider or domain, and move the types there:
   ```bash
   cd back-end && grep -rn "from.*types/person" src/
   ```

After moving, update all imports. Delete `src/types/` if only `.d.ts` files remain (rename to `src/typings/` for clarity, conventional for ambient declarations).

## Step 7: Verify

### 7a. TypeScript compilation
```bash
cd back-end && npx tsc --noEmit
```
Must compile with 0 errors.

### 7b. Structural tests (if they exist)
```bash
cd back-end && npx tsx src/tests/structural/layer-deps.test.ts
```
Must pass for all existing domains.

### 7c. Boundary verification
```bash
# No provider imports from domains
grep -rn "from.*domains/" src/providers/ src/utils/ 2>/dev/null

# No util imports from src/
grep -rn "from '\.\." src/utils/ 2>/dev/null
```
Both must return 0 results.

### 7d. ESLint
```bash
cd back-end && npx eslint src/providers/*.ts src/utils/*.ts
```

### 7e. Blackbox tests
```bash
cd back-end && npm run test:api
```
Full suite must pass — provider/util moves can break imports that affect any domain.

## Step 8: Report

Output:
- **Inventory table:** every file in providers/, utils/, types/ with classification
- **Misplaced files found and fixed** (moved from → to)
- **Boundary violations found and fixed**
- **Duplicated patterns found:**
  - Extracted now (to which provider/util)
  - Deferred to domain refactoring (with note of which domain)
- **Orphaned types consolidated** (moved from types/ to which provider/domain)
- **Test results:** tsc, structural, eslint, blackbox

Only say **`Audit complete`** if ALL of:
- [ ] Zero misplaced files remain (all files classified correctly)
- [ ] Zero boundary violations (providers don't import domains, utils don't import src/)
- [ ] Orphaned types in `types/` consolidated (except `.d.ts` ambient declarations)
- [ ] TypeScript compiles with 0 errors
- [ ] Structural tests pass (if they exist)
- [ ] ESLint passes on providers/ and utils/
- [ ] Blackbox tests pass
