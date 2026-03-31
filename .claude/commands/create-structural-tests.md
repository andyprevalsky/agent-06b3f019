---
description: "Create or extend the codebase-wide structural test suite, then verify a specific domain passes all invariants."
argument-hint: "<domain-name>"
---

# Create Structural Tests

Build and maintain the structural test suite that mechanically enforces the layered domain architecture. The suite auto-discovers all domains — adding one domain benefits every future domain.

If `$ARGUMENTS` is empty, ask the user for the domain name and stop.

**This is a loop. Do NOT stop after partial work. Continue until all structural tests exist, pass for the target domain, and fail on deliberate violations.**

## What structural tests enforce

Structural tests verify the codebase is **shaped correctly** before any code runs. They parse source files statically (no server needed, near-instant). This is the first line of defense — an agent hits a structural failure before it even gets to runtime.

## The invariants

All 9 invariants below MUST be covered by the test suite. They are grouped into categories.

**Not included here (already enforced by ESLint):** `no-console` (base config), `max-lines` / `max-lines-per-function` (strict overlay). See `back-end/eslint.config.mjs`.

### 1. Import direction (per domain layer)

Each layer can only import from layers below it and from allowed external sources. This is the core architectural rule.

```
types.ts   → external packages + providers (Prisma generated types only)
config.ts  → own types + external packages
repo.ts    → own types, own config, providers/database (+ other providers for Prisma types)
service.ts → own repo, own types, own config, providers/*
routes.ts  → own service, own types, providers/* (auth middleware), utils/asyncHandler
```

**Remediation message format:**
```
LAYER VIOLATION in domains/attention-requests/repo.ts:
  Imports from './service' but repo may only import from: types, config, providers/*
  → Fix: Move the needed logic into repo.ts, or extract it to a provider.
```

### 2. Cross-domain isolation

No domain may import from another domain. Shared logic lives in providers.

**Remediation:**
```
CROSS-DOMAIN VIOLATION in domains/agents/service.ts:
  Imports from '../attention-requests/repo'
  → Fix: Extract shared logic into providers/ so both domains can use it.
```

### 3. Provider boundary

Providers (`src/providers/`) must NEVER import from `src/domains/`. Providers are domain-agnostic. They may import from `utils/` and external packages only.

**Remediation:**
```
PROVIDER BOUNDARY VIOLATION in providers/credits.ts:
  Imports from '../domains/agents/types'
  → Fix: Move the shared type to the provider itself or to a shared types export within providers/.
```

### 4. Utils boundary

Utils (`src/utils/`) must NEVER import from anything in `src/` (no providers, no domains). They are pure functions that could be copy-pasted into any project.

**Remediation:**
```
UTILS BOUNDARY VIOLATION in utils/log.ts:
  Imports from '../providers/logger'
  → Fix: utils/ must have zero src/ dependencies. Move this to providers/ or inline it.
```

### 5. Domain completeness

Every directory in `src/domains/` must contain exactly these 5 files: `types.ts`, `config.ts`, `repo.ts`, `service.ts`, `routes.ts`.

Large domains may have additional service files (e.g., `agentLifecycleService.ts`), which is allowed. But the 5 core files must always exist.

**Remediation:**
```
COMPLETENESS VIOLATION in domains/attention-requests:
  Missing: config.ts
  → Fix: Create the file. If the domain has no config, use: export {};
```

### 6. No Prisma outside repo

Prisma client imports (`from '...prisma'`, `from '...database'`, `@prisma/client`) must only appear in:
- `domains/*/repo.ts` files
- `providers/database.ts` (or `providers/prisma.ts`)

Any other file importing Prisma is a violation.

**Remediation:**
```
PRISMA BOUNDARY VIOLATION in domains/agents/service.ts:
  Imports Prisma directly but only repo.ts and providers/database.ts may use Prisma
  → Fix: Move the query to repo.ts and call it from service.ts.
```

### 7. No req/res outside routes

Express request/response types (`Request`, `Response`, `NextFunction`, `Router`) and the `express` package must only appear in:
- `domains/*/routes.ts` files
- `providers/*.ts` files (auth middleware needs these)
- `utils/asyncHandler.ts`

If `service.ts`, `repo.ts`, `types.ts`, or `config.ts` import Express types, it's a violation.

**Remediation:**
```
EXPRESS LEAK in domains/agents/service.ts:
  Imports 'express' but service must be framework-agnostic
  → Fix: Accept typed args instead of req/res. Move HTTP handling to routes.ts.
```

### 8. No circular imports

Scan for import cycles within and across domain files. A cycle means A imports B which imports A (directly or transitively).

**Remediation:**
```
CIRCULAR IMPORT in domains/agents/:
  service.ts → repo.ts → service.ts
  → Fix: Break the cycle by moving shared logic to a lower layer or extracting to a provider.
```

### 9. server.ts wiring

`server.ts` must import domain routers from `src/domains/*/routes.ts`, NOT from `src/routes/*.ts` (for refactored domains). This verifies the wiring was updated during refactoring.

Only check domains that exist in `src/domains/` — domains still in `src/routes/` haven't been refactored yet and are exempt.

**Remediation:**
```
WIRING VIOLATION in server.ts:
  Imports attentionRequests from './routes/attentionRequests' but domain exists at ./domains/attention-requests/routes
  → Fix: Update the import path in server.ts to point to the domains/ location.
```

## Test file location

All structural tests live in a single file:

```
back-end/src/tests/structural/layer-deps.test.ts
```

This file auto-discovers all domains in `src/domains/` and all providers/utils. Adding a new domain means the test automatically picks it up.

## Execution

### Step 1: Check prerequisites

Verify the domain exists in `src/domains/$ARGUMENTS/`. If it doesn't:
- Check if it exists in `src/routes/` (not yet refactored) → tell the user to run `/refactor-domain-for-full-autonomy $ARGUMENTS` first and stop.
- If it doesn't exist anywhere → tell the user the domain name is wrong and stop.

### Step 2: Read the existing structural test

Read `back-end/src/tests/structural/layer-deps.test.ts`. Assess which of the 9 invariants above are already implemented.

### Step 3: Implement missing invariants

For each invariant not yet covered, add it to the test file. The test must:
1. Auto-discover all domains (never hardcode domain names)
2. Parse imports from source files using regex
3. Classify each import (same-domain layer, other domain, provider, util, external)
4. Check against allowed rules for that invariant
5. Output remediation messages with the exact format shown above (so agents know how to fix)

Structural guidelines for the test file:
- Use `npx tsx` as runner (no Jest dependency needed for structural tests)
- Exit 0 on pass, exit 1 on fail
- Print per-domain, per-file results
- Print summary with pass/fail counts
- Group violations by category (import direction, boundary, completeness, etc.)

### Step 4: Run and verify

```bash
cd back-end && npx tsx src/tests/structural/layer-deps.test.ts
```

Must pass with 0 violations for the target domain.

If there are violations, they indicate real problems. **Fix the domain code, not the test.** The invariants are non-negotiable.

### Step 5: Negative-control checks

For each invariant category, make a temporary deliberate violation and verify the test catches it:

1. **Import direction**: Add `import * as service from './service'` to `repo.ts` → verify LAYER VIOLATION
2. **Cross-domain**: Add `import { something } from '../other-domain/repo'` to `service.ts` → verify CROSS-DOMAIN VIOLATION
3. **Provider boundary**: Add `import { something } from '../domains/X/types'` to a provider → verify PROVIDER BOUNDARY VIOLATION
4. **Utils boundary**: Add `import { something } from '../providers/database'` to a utils file → verify UTILS BOUNDARY VIOLATION
5. **Domain completeness**: Temporarily rename `config.ts` to `config.bak` → verify COMPLETENESS VIOLATION
6. **Prisma boundary**: Add a Prisma import to `service.ts` → verify PRISMA BOUNDARY VIOLATION
7. **Express leak**: Add `import { Request } from 'express'` to `service.ts` → verify EXPRESS LEAK
8. **Circular imports**: Add `import { something } from './service'` to `repo.ts` and `import { something } from './repo'` to `service.ts` → verify CIRCULAR IMPORT
9. **server.ts wiring**: If the target domain exists in `src/domains/`, temporarily change its import in `server.ts` to point to `./routes/` instead → verify WIRING VIOLATION

Revert each violation immediately after confirming the test catches it.

### Step 6: Run full suite

Run the structural test to verify ALL domains pass (not just the target):

```bash
cd back-end && npx tsx src/tests/structural/layer-deps.test.ts
```

Also run the blackbox tests to ensure structural test additions didn't inadvertently modify any behavior:

```bash
cd back-end && npm run test:api
```

### Step 7: Report

Output:
- Which invariants were already covered vs. newly added
- Per-domain structural test results (pass/fail)
- Negative-control check results (caught/missed per invariant)
- Any violations found in non-target domains (these are known issues for future refactoring)

Only say **`Structural tests complete`** if ALL of:
- [ ] All 9 invariants are implemented in the test file
- [ ] Target domain passes all invariants
- [ ] All 9 negative-control checks passed (caught the deliberate violation)
- [ ] Test auto-discovers domains (no hardcoded domain names)
- [ ] Remediation messages include fix instructions
- [ ] Blackbox tests still pass
