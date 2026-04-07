---
description: "Create or extend the codebase-wide structural test suite, then verify a specific domain passes all invariants."
argument-hint: "<domain-name>"
---

# Create Structural Tests

Build and maintain the structural test suite that mechanically enforces the layered domain architecture. The suite auto-discovers all domains — adding one domain benefits every future domain.

Read `.context/attachments/pasted_text_2026-04-05_20-13-11.txt` for the foundational thinking. Key insight: "Structural tests verify the codebase is shaped correctly before any code runs. They parse source files statically (no server needed, near-instant). This is the first line of defense."

If `$ARGUMENTS` is empty, ask the user for the domain name and stop.

**This is a loop. Do NOT stop after partial work. Continue until all structural tests exist, pass for the target domain, and fail on deliberate violations.**

## Step 0: Verify required scripts

```bash
find . -maxdepth 3 -name 'map-domains.*' -o -name 'map_domains.*' | grep -v node_modules | grep -v __pycache__
```

**If no domain mapping script is found:** Run `/map-domains` first. It will analyze the codebase and write the mapping script.

Also check if a structural test file already exists (this skill creates it if not):

```bash
find . -maxdepth 5 -path '*/tests/structural/*' -name 'layer-deps.*' | grep -v node_modules | grep -v __pycache__
```

## The invariants

All invariants below MUST be covered by the test suite. They are grouped into categories. The exact patterns depend on the codebase's language and framework, but the **principles** are universal.

### 1. Import direction (per domain layer)

Each layer can only import from layers below it and from allowed external sources. This is the core architectural rule.

```
types/schemas  → external packages + provider types (e.g., ORM-generated types)
config         → own types + external packages
repo/data      → own types, own config, providers/database
service/logic  → own repo, own types, own config, providers/*
runtime/handler → own service, own types, providers/*, utils/
```

**Frontend variant (if codebase uses features/):**
```
shared/utils/           → nothing from project source tree
shared/lib/             → shared/utils/ only
features/*/types        → external packages + shared/types/
features/*/config       → own types
features/*/api          → own types, own config, shared/lib/
features/*/hooks        → own api, own types, own config, shared/*
features/*/components   → own hooks, own types, shared/components/, shared/hooks/
```

The structural test must detect which directory structure exists (`domains/` vs `features/`) and apply the corresponding rules.

**Remediation message format:**
```
LAYER VIOLATION in domains/<domain>/repo:
  Imports from './service' but repo may only import from: types, config, providers/*
  → Fix: Move the needed logic into repo, or extract it to a provider.
```

### 2. Cross-domain isolation

No domain may import from another domain. Shared logic lives in providers.

**Remediation:**
```
CROSS-DOMAIN VIOLATION in domains/<domain-a>/service:
  Imports from '../<domain-b>/repo'
  → Fix: Extract shared logic into providers/ so both domains can use it.
```

### 3. Provider boundary

Providers must NEVER import from domains. Providers are domain-agnostic. They may import from utils and external packages only.

**Remediation:**
```
PROVIDER BOUNDARY VIOLATION in providers/<file>:
  Imports from domains/<domain>/types
  → Fix: Move the shared type to the provider itself or to a shared types export within providers/.
```

### 4. Utils boundary

Utils must NEVER import from anything in the project's source tree (no providers, no domains). They are pure functions that could be copy-pasted into any project.

**Remediation:**
```
UTILS BOUNDARY VIOLATION in utils/<file>:
  Imports from providers/<file>
  → Fix: utils/ must have zero project dependencies. Move this to providers/ or inline it.
```

### 5. Domain completeness

Every domain directory must contain all required layer files. Large domains may have additional files (e.g., split service files), which is allowed.

**Backend required files:** types, config, repo, service, runtime/handler.
**Frontend required files:** types, api, hooks, components/ (directory with at least one component), index.ts. Optional: config.

The test must detect whether the codebase uses `domains/` or `features/` and check the appropriate layer file set.

**Remediation:**
```
COMPLETENESS VIOLATION in domains/<domain>:
  Missing: config
  → Fix: Create the file. If the domain has no config, use an empty export.
```

### 6. Data access outside repo

Data access client imports (ORM, database client) must only appear in:
- `domains/*/repo.*` files
- The database provider file

Any other file importing the data client is a violation.

**Language-specific patterns to detect:**
- TypeScript: `from '...prisma'`, `from '...database'`, `@prisma/client`
- Python: `from ... import prisma`, `import sqlalchemy`, `from ... import db`
- Go: `import "database/sql"`, ORM package imports
- Frontend (React): `fetch(`, `axios.`, `useQuery(`/`useMutation(` from `@tanstack/react-query` — only allowed in `features/*/api.*` files and `shared/lib/`

**Remediation:**
```
DATA ACCESS BOUNDARY VIOLATION in domains/<domain>/service:
  Imports data client directly but only repo and providers/database may use it
  → Fix: Move the query to repo and call it from service.
```

### 7. No request/response outside runtime layer

HTTP/framework types (Request, Response, Router, etc.) must only appear in:
- `domains/*/routes.*` or `domains/*/handler.*` files
- Provider files (auth middleware needs these)
- Utils that wrap framework concepts (asyncHandler, error middleware)

If service, repo, types, or config files import framework types, it's a violation.

**Frontend framework types to detect:**
- React Router: `useNavigate`, `useParams`, `useSearchParams`, `Link`, `Navigate` — only allowed in `components/` and page files
- Next.js Router: `useRouter`, `usePathname`, `redirect` — same restriction
- DOM APIs: `document.getElementById`, `window.location` — only in components or shared hooks
- `React.lazy`, `Suspense` — only in page/layout files (composition, not feature logic)

If `api.ts`, `hooks.ts`, or `types.ts` import router/navigation types, it is a FRAMEWORK LEAK.

**Remediation:**
```
FRAMEWORK LEAK in domains/<domain>/service:
  Imports framework types but service must be framework-agnostic
  → Fix: Accept typed args instead of request/response. Move HTTP handling to the runtime layer.
```

### 8. No circular imports

Scan for import cycles within and across domain files. A cycle means A imports B which imports A (directly or transitively).

**Remediation:**
```
CIRCULAR IMPORT in domains/<domain>/:
  service → repo → service
  → Fix: Break the cycle by moving shared logic to a lower layer or extracting to a provider.
```

### 9. Wiring file correctness

The application entry point (server.ts, worker.py, main.go, etc.) must import domain handlers from the `domains/` directory, NOT from the old flat structure (for refactored domains).

Only check domains that exist in the `domains/` directory — domains not yet refactored are exempt.

**Remediation:**
```
WIRING VIOLATION in <entry-point>:
  Imports <domain> from old location but domain exists at domains/<domain>/
  → Fix: Update the import path to point to the domains/ location.
```

### 10. Public API enforcement (frontend only)

Every feature directory must have an `index.ts` barrel file. External consumers (pages, other features via shared state) must import from the barrel, not from internal layer files.

**Detection:** For every import statement in `pages/`, `app/`, or other features that references a path under `features/<name>/`, verify the import resolves to `features/<name>/index.ts` (or `features/<name>/`), not to `features/<name>/api.ts`, `features/<name>/hooks.ts`, etc.

**Remediation:**
```
PUBLIC API VIOLATION in pages/Dashboard.tsx:
  Imports from 'features/billing/hooks' but must import via 'features/billing'
  → Fix: Re-export the needed symbol from features/billing/index.ts and import from there.
```

Skip this invariant for backend codebases (no `features/` directory).

## Execution

### Step 1: Check prerequisites

Verify the domain exists in the domains directory. If it doesn't:
- Check if it exists in the old flat structure (not yet refactored) → tell the user to run `/refactor-domain-for-full-autonomy $ARGUMENTS` first
- If it doesn't exist anywhere → the domain name is wrong

### Step 2: Read the existing structural test

If the structural test file exists, assess which of the invariants above are already implemented.

### Step 3: Implement missing invariants

For each invariant not yet covered, add it to the structural test file. The test must:
1. **Auto-discover all domains** (never hardcode domain names)
2. **Parse imports from source files** using AST parsing or reliable regex for the codebase's language
3. **Classify each import** (same-domain layer, other domain, provider, util, external)
4. **Check against allowed rules** for that invariant
5. **Output remediation messages** with the exact format shown above (so agents know how to fix)

Structural test guidelines:
- Use the codebase's native test runner or a standalone script
- Exit 0 on pass, exit 1 on fail
- Print per-domain, per-file results
- Print summary with pass/fail counts
- Group violations by category

### Step 4: Run and verify

Run the structural test. Must pass with 0 violations for the target domain.

If there are violations, they indicate real problems. **Fix the domain code, not the test.** The invariants are non-negotiable.

### Step 5: Negative-control checks

For each invariant category, make a temporary deliberate violation and verify the test catches it:

1. **Import direction**: Add an import from service in repo → verify LAYER VIOLATION
2. **Cross-domain**: Add an import from another domain → verify CROSS-DOMAIN VIOLATION
3. **Provider boundary**: Add a domain import in a provider → verify PROVIDER BOUNDARY VIOLATION
4. **Utils boundary**: Add a project import in utils → verify UTILS BOUNDARY VIOLATION
5. **Domain completeness**: Temporarily rename a layer file → verify COMPLETENESS VIOLATION
6. **Data access boundary**: Add a data client import in service → verify DATA ACCESS BOUNDARY VIOLATION
7. **Framework leak**: Add a framework type import in service → verify FRAMEWORK LEAK
8. **Circular imports**: Create a bidirectional import → verify CIRCULAR IMPORT
9. **Wiring correctness**: Point the entry file import to the old location → verify WIRING VIOLATION
10. **(Frontend only) Public API violation**: Import a feature's `hooks.ts` directly from a page file → verify PUBLIC API VIOLATION

Revert each violation immediately after confirming the test catches it.

### Step 6: Run full suite

Run the structural test to verify ALL domains pass (not just the target). Also run the blackbox tests to ensure structural test additions didn't inadvertently modify any behavior.

### Step 7: Report

Output:
- Which invariants were already covered vs. newly added
- Per-domain structural test results (pass/fail)
- Negative-control check results (caught/missed per invariant)
- Any violations found in non-target domains (known issues for future refactoring)

Only say **`Structural tests complete`** if ALL of:
- [ ] All invariants are implemented in the test file
- [ ] Target domain passes all invariants
- [ ] All negative-control checks passed (caught the deliberate violation)
- [ ] Test auto-discovers domains (no hardcoded domain names)
- [ ] Remediation messages include fix instructions
- [ ] Blackbox tests still pass
