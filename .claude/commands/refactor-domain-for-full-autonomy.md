---
description: "Refactor a backend domain into layered architecture (Types → Config → Repo → Service → Routes) for full agent autonomy."
argument-hint: "<domain-name>"
---

# Refactor Domain for Full Autonomy

Decompose a flat backend route file into the layered domain architecture. Strict boundaries and predictable structure enable agents to ship fast without architectural decay.

If `$ARGUMENTS` is empty, ask the user for the domain name and stop.

**This is a loop. Do NOT stop after partial work. Continue until the domain is fully layered, all imports are correct, and all tests pass.**

## The Architecture

```
src/
├── domains/<domain>/        # Business logic (domain-specific)
│   ├── types.ts             # Zod schemas + TS interfaces
│   ├── config.ts            # Constants, defaults, env reads
│   ├── repo.ts              # Prisma queries (sole DB consumer)
│   ├── service.ts           # Business logic orchestration
│   └── routes.ts            # Thin Express controller
├── providers/               # Cross-cutting concerns (shared across domains)
│   ├── auth.ts              # Auth middleware, AuthRequest type
│   ├── database.ts          # Prisma client
│   ├── temporal.ts          # Temporal workflow client
│   ├── logger.ts            # Structured logging (wraps utils)
│   └── ...                  # storage, steel, credits, etc.
├── utils/                   # Pure functions (zero side effects, zero src/ imports)
│   ├── log.ts               # Truncation helper
│   └── asyncHandler.ts      # Express error wrapper
└── server.ts
```

### Import direction rules (forward-only, never reverse)

```
utils/             → imports nothing from src/
providers/         → imports from utils/ only
domains/*/types.ts   → imports nothing domain-specific (external packages + providers for Prisma types only)
domains/*/config.ts  → imports from own types
domains/*/repo.ts    → imports from own types, own config, providers/database
domains/*/service.ts → imports from own repo, own types, own config, providers/*
domains/*/routes.ts  → imports from own service, own types, providers/* (auth), utils/asyncHandler
```

**Domains NEVER import from other domains.** Shared logic lives in providers.
**Domains NEVER import from utils/ directly** except `routes.ts` may import `asyncHandler` (app wiring layer).

### What each layer does

| Layer | Contains | Forbidden |
|---|---|---|
| **types.ts** | Zod schemas, TS interfaces, enums, type aliases | Imports from other domain files, business logic, I/O |
| **config.ts** | Constants, default values, domain-specific env reads | Prisma, HTTP concepts, business logic |
| **repo.ts** | Named functions wrapping Prisma queries. Typed args in, typed results out | `req`/`res`, business logic, direct provider calls (except database) |
| **service.ts** | Business logic orchestrating repo + providers. Typed args in, typed results out | `req`/`res`, direct Prisma imports, inline DB queries |
| **routes.ts** | Parse request → call service → send response. Thin controller | Prisma imports, inline business logic, inline Zod schemas |

## Prerequisites

Verify before starting:

1. **Blackbox tests exist** for this domain (`back-end/src/tests/blackbox/<domain>.blackbox.ts`). If not, tell the user to run `/create-domain-blackbox-tests $ARGUMENTS` first and stop.

## Step 0: One-time infrastructure setup

**Skip this entire step if `src/providers/` already exists.**

This runs ONCE for the entire codebase, on the first domain refactor.

### 0a. Create directories

```bash
cd back-end && mkdir -p src/providers src/utils src/domains
```

### 0b. Move files from lib/ and middleware/ to providers/ and utils/

Classify every file in `lib/` and `middleware/`:

**→ providers/** — anything with side effects, I/O, or external service wrappers:
- `lib/prisma.ts` → `providers/database.ts`
- `middleware/auth.ts` → `providers/auth.ts`
- `middleware/hybridAuth.ts` → `providers/hybridAuth.ts`
- `lib/logger.ts` → `providers/logger.ts`
- All other `lib/*.ts` files that do I/O (temporal, storage, steel, credits, messages, embeddings, etc.)
- All `lib/` subdirectories (chat/, smsSupervisor/) → `providers/` subdirectories

**→ utils/** — pure functions with zero side effects AND zero imports from `src/`:
- `lib/log.ts` → `utils/log.ts`
- `lib/asyncHandler.ts` → `utils/asyncHandler.ts`

**How to decide:** If the file imports Prisma, calls an API, or reads env vars, it's a provider. If it's a pure function you could copy into any project, it's a util.

### 0c. Update ALL imports across the entire codebase

For every `.ts` file in `src/`, update import paths to reflect the new locations. This is mechanical find-and-replace. Examples:
- `from '../lib/prisma'` → `from '../providers/database'`
- `from '../middleware/auth'` → `from '../providers/auth'`
- `from '../lib/log'` → `from '../utils/log'`
- `from '../lib/logger'` → `from '../providers/logger'`

Use the editor to do this file by file. Do NOT leave any broken imports.

### 0d. Verify

```bash
cd back-end && npx tsc --noEmit
```

TypeScript must compile with 0 errors. If it doesn't, fix broken imports.

Then run the full blackbox test suite to verify no behavior changes.

### 0e. Commit separately

```bash
git add back-end/src/providers back-end/src/utils
git add -u back-end/src/  # picks up renames/deletes
git commit -m "infra: restructure lib/ and middleware/ into providers/ and utils/"
```

**This commit is infrastructure only. No business logic changes. Proceed to domain work.**

## Step 1: Map the domain

```bash
cd back-end && npx tsx scripts/map-domains.ts $ARGUMENTS
```

Identify the route file. Note: the domain's import graph will include providers — those stay where they are. Only the route file itself gets decomposed.

## Step 2: Create domain folder

```bash
mkdir -p back-end/src/domains/$ARGUMENTS
```

Create ALL five files — every domain gets every layer, even if some are small. Consistency is the point: agents always know where to look.

- `types.ts`
- `config.ts`
- `repo.ts`
- `service.ts`
- `routes.ts`

## Step 3: Extract types → types.ts

Move from the route file:
- All Zod schemas (request/response validation)
- All TypeScript interfaces and type aliases
- All enums

Export everything. `types.ts` imports ONLY external packages (zod, express types for `Request`/`Response` if needed) and providers (for Prisma-generated types if needed).

## Step 4: Extract config → config.ts

Move from the route file:
- Magic numbers and string constants
- Default values and limits
- Domain-specific `process.env` reads

`config.ts` may import from `types.ts` only. If the domain has no config, create the file with a comment and an empty export:

```typescript
// No domain-specific config. File exists for layer consistency.
export {};
```

## Step 5: Extract repo → repo.ts

Move ALL Prisma calls from the route file. Each query becomes a named, exported async function.

Rules:
- **Typed args in, typed results out.** Use types from `types.ts`.
- **No `req`/`res` parameters.** Repo is framework-agnostic.
- **Import Prisma from `providers/database`** (or `providers/prisma` depending on Step 0 naming).
- **No business logic.** Just data access: find, create, update, delete, count.

Example transformation:
```typescript
// BEFORE (inline in route handler)
const request = await prisma.attentionRequest.findUnique({
  where: { id },
  include: { agent: true },
});

// AFTER (repo.ts)
import { prisma } from '../providers/database';

export async function findById(id: string) {
  return prisma.attentionRequest.findUnique({
    where: { id },
    include: { agent: true },
  });
}
```

## Step 6: Extract service → service.ts

Move business logic from the route file. Each operation becomes a named, exported function.

Rules:
- **Typed args in, typed results out.** NO `req`/`res`.
- **Call repo functions for data access.** NEVER import Prisma directly.
- **May import providers/** for cross-cutting operations (credits, temporal, storage, logger).
- **Throw typed errors** for conditions that map to HTTP status codes:

```typescript
// service.ts
import * as repo from './repo';

export class NotFoundError extends Error { constructor(msg: string) { super(msg); } }
export class ForbiddenError extends Error { constructor(msg: string) { super(msg); } }

export async function respond(requestId: string, userId: string, data: RespondInput) {
  const request = await repo.findById(requestId);
  if (request === null) throw new NotFoundError('Attention request not found');
  if (request.userId !== userId) throw new ForbiddenError('Not your request');
  return repo.updateStatus(requestId, 'responded', data);
}
```

**For large domains** (agents, integrations) where service.ts would exceed 300 lines: split into multiple service files by sub-concern (e.g., `agentLifecycleService.ts`, `agentFileService.ts`). Each service file follows the same import rules.

## Step 7: Rewrite routes → routes.ts

The route file becomes a thin controller. Each handler does ONLY:
1. Parse/validate the request (Zod schemas imported from `types.ts`)
2. Extract auth context (from middleware/provider)
3. Call a service function with typed args
4. Catch service errors and map to HTTP status codes
5. Send the response

Rules:
- `asyncHandler()` wraps every async handler
- No Prisma imports
- No inline business logic
- No inline Zod schemas (import from types.ts)
- No `console.*` (use logger from providers)
- Target: under 150 lines. Must stay under 300 (ESLint max-lines)

Example:
```typescript
import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { authenticate, type AuthRequest } from '../providers/auth';
import * as service from './service';
import { respondSchema } from './types';
import { NotFoundError, ForbiddenError } from './service';

const router = Router();

router.post('/:id/respond', authenticate, asyncHandler<AuthRequest>(async (req, res) => {
  const body = respondSchema.parse(req.body);
  const result = await service.respond(req.params.id, req.userId, body);
  res.json(result);
}));

export default router;
```

Error mapping pattern (put at the bottom of routes.ts or in a shared util):
```typescript
function mapError(error: unknown, res: Response): void {
  if (error instanceof NotFoundError) { res.status(404).json({ error: error.message }); return; }
  if (error instanceof ForbiddenError) { res.status(403).json({ error: error.message }); return; }
  throw error; // re-throw unexpected errors for asyncHandler/Express to catch
}
```

## Step 8: Update server.ts

Change the import path for this domain's router:

```typescript
// BEFORE
import attentionRequestsRouter from './routes/attentionRequests';

// AFTER
import attentionRequestsRouter from './domains/attention-requests/routes';
```

The mount path (e.g., `/api/attention-requests`) does NOT change. Only the import path.

## Step 9: Delete the old route file

```bash
rm back-end/src/routes/<routeFile>.ts
```

Check if `src/routes/` is now empty. If all domains have been refactored, delete the directory.

## Step 10: Verify import directions

For each file in the new domain folder, manually verify every import statement:

- **types.ts**: only external packages + providers for Prisma types
- **config.ts**: only own types.ts + external packages
- **repo.ts**: only own types.ts, own config.ts, providers/database
- **service.ts**: only own repo, own types, own config, providers/*
- **routes.ts**: only own service, own types, providers/*, utils/asyncHandler

**Violations to catch:**
- repo.ts importing from service.ts → fix: move logic down to repo or up to a provider
- service.ts importing `req`/`res` types → fix: use typed args instead
- routes.ts importing Prisma → fix: move query to repo, call via service
- Any file importing from another domain → fix: extract shared logic to a provider

## Step 11: Structural dependency test

Check if `src/tests/structural/layer-deps.test.ts` exists. If not, create it. This test runs once and covers ALL domains automatically.

The test must:
1. Scan all `.ts` files in `src/domains/*/`
2. Determine each file's layer from its filename
3. Parse all `import ... from '...'` statements
4. Classify each import (same-domain layer, other domain, provider, util, external)
5. Verify against allowed imports for that layer
6. **Fail with remediation messages** (so agents know exactly how to fix):

```
LAYER VIOLATION in domains/attention-requests/repo.ts:
  Imports from './service' but repo may only import from: types, config, providers/*
  → Fix: Move the needed logic into repo.ts, or extract it to a provider.

CROSS-DOMAIN VIOLATION in domains/agents/service.ts:
  Imports from '../attention-requests/repo'
  → Fix: Extract shared logic into providers/ so both domains can use it.
```

Run the structural test:
```bash
cd back-end && npx jest src/tests/structural/layer-deps.test.ts
```

## Step 12: Format, lint, and enforce strict rules

This step integrates the full formatter/linter setup. Do NOT skip any sub-step.

### 12a. Run Prettier

```bash
cd back-end && npx prettier --write src/domains/$ARGUMENTS/*.ts
```

### 12b. Run ESLint auto-fix (base rules first)

```bash
cd back-end && npx eslint --fix src/domains/$ARGUMENTS/*.ts
```

### 12c. Add domain files to strict enforcement

Add ALL files in the domain to `STRICT_DOMAIN_FILES` in `back-end/eslint.config.mjs`. Remove the old route file entry if it was previously listed. Include any split service files (e.g., `agentLifecycleService.ts`).

### 12d. Fix remaining strict rule violations

Run ESLint under strict rules and fix every error manually:

```bash
cd back-end && npx eslint src/domains/$ARGUMENTS/*.ts
```

Strict rules enforced on domain files:

| Rule | Fix |
|---|---|
| `max-lines` (300) | Extract helpers or split the file |
| `max-lines-per-function` (80) | Extract sub-functions |
| `no-floating-promises` | Add `await` or `void` prefix |
| `no-misused-promises` | Don't pass async functions where sync callbacks are expected |
| `strict-boolean-expressions` | Use explicit comparisons (`!== null`, `!== undefined`, `.length > 0`) |
| `consistent-type-imports` | Change `import { Foo }` to `import type { Foo }` for type-only imports |

**Do NOT add eslint-disable comments.** Fix the actual code. The only exception is if a fix would change observable behavior — document why and get user approval.

### 12e. Verify clean

Loop until BOTH report 0 errors:

```bash
cd back-end
npx prettier --check src/domains/$ARGUMENTS/*.ts
npx eslint src/domains/$ARGUMENTS/*.ts
```

## Step 13: Run blackbox tests

```bash
cd back-end && npm run test:api
```

Run the FULL suite — server.ts imports changed, so all domains could be affected.

If tests fail, the refactor introduced a behavior change. **Fix the domain code, not the tests.** The behavior must be identical.

**Do NOT modify prompts, system messages, or any LLM-facing strings.** This includes agent system prompts, tool descriptions, user-facing error messages sent to LLMs, and any string that ends up in an LLM context window. If a lint rule flags code inside a prompt string, suppress with an eslint-disable comment rather than altering the prompt content.

## Step 14: Report

Output:
- Domain folder structure with all 5 layer files
- Import direction verification (pass/fail per file)
- Structural dependency test result
- Blackbox test result
- ESLint strict result
- Files deleted (old route file)
- Any large-domain splits (multiple service files)

Only say **`Domain refactor complete`** if ALL of:
- [ ] Domain folder has all 5 layer files
- [ ] All imports follow forward-only direction rules
- [ ] Old route file is deleted
- [ ] server.ts import updated
- [ ] Structural dependency test passes
- [ ] Prettier check passes (`npx prettier --check src/domains/$ARGUMENTS/*.ts`)
- [ ] ESLint strict rules pass with 0 errors
- [ ] Blackbox tests pass
