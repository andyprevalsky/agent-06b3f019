---
description: "Refactor a domain into layered architecture for full agent autonomy. Adapts the layer structure to the codebase's language and framework."
argument-hint: "<domain-name>"
---

# Refactor Domain for Full Autonomy

Decompose a flat entry file into the layered domain architecture. Strict boundaries and predictable structure enable agents to ship fast without architectural decay.

Read `.context/attachments/pasted_text_2026-04-05_20-13-11.txt` for the foundational thinking. Key insight: "Each business domain is divided into a fixed set of layers, with strictly validated dependency directions and a limited set of permissible edges."

If `$ARGUMENTS` is empty, ask the user for the domain name and stop.

**This is a loop. Do NOT stop after partial work. Continue until the domain is fully layered, all imports are correct, and all tests pass.**

**Running under `/batch` (parallel workers)?** The coordinator MUST pre-seed the shared infrastructure (Step 0b: `domains/`, `providers/`, `utils/` directories + any shared-file classification/moves) on the parent branch BEFORE spawning workers. Parallel workers racing on Step 0b produce unresolvable conflicts. See Step 0b for details.

## The Architecture

The exact layers depend on the codebase's language and framework, but the **principle** is universal: separate concerns into layers with forward-only import directions.

### Layer template

| Layer | Purpose | May import from |
|---|---|---|
| **Types** | Schemas, interfaces, enums, type aliases | External packages only (+ ORM types from providers) |
| **Config** | Constants, defaults, env reads | Own types |
| **Repo / Data** | Data access (DB queries, file reads). Typed args in, typed results out | Own types, own config, providers/database |
| **Service / Logic** | Business logic orchestration. Typed args in, typed results out | Own repo, own types, own config, providers/* |
| **Runtime** | Thin controller/handler: parse input → call service → send output | Own service, own types, providers/*, utils/asyncHandler |

### Language-specific layer files

**TypeScript/Express:**
```
domains/<domain>/
├── types.ts      # Zod schemas + TS interfaces
├── config.ts     # Constants, defaults, env reads
├── repo.ts       # Prisma queries (sole DB consumer)
├── service.ts    # Business logic orchestration
└── routes.ts     # Thin Express controller
```

**Python (tools/activities):**
```
domains/<domain>/
├── types.py      # Pydantic models, TypedDicts, enums
├── config.py     # Constants, defaults, env reads
├── repo.py       # Data access (DB, file I/O)
├── service.py    # Business logic orchestration
└── handler.py    # Entry point (tool execute(), activity function, CLI handler)
```

**Go:**
```
domains/<domain>/
├── types.go      # Structs, interfaces
├── config.go     # Constants, env reads
├── repo.go       # Data access
├── service.go    # Business logic
└── handler.go    # HTTP handler / gRPC server
```

**React/TypeScript (Frontend):**
```
features/<feature>/
├── types.ts        # Zod schemas, TS interfaces, prop types
├── config.ts       # Constants, feature flags, defaults (optional — create if needed)
├── api.ts          # Data fetching: React Query hooks, HTTP calls (sole API consumer)
├── hooks.ts        # Business logic orchestration (custom hooks)
├── components/     # UI components (thin: call hooks, render JSX)
│   ├── FeatureList.tsx
│   └── FeatureDetail.tsx
└── index.ts        # Public API barrel — re-exports ONLY what external consumers need
```

Note: Frontend uses `features/` not `domains/`, and `shared/` not `providers/`. The directory names differ but the layering principle is identical. The `index.ts` barrel is mandatory for frontend — it encapsulates the feature so consumers import from `features/auth`, never from `features/auth/hooks`.

### Import direction rules (forward-only, never reverse)

```
utils/              → imports nothing from the project's source tree
providers/          → imports from utils/ only
domains/*/types     → imports nothing domain-specific (external + provider types only)
domains/*/config    → imports from own types
domains/*/repo      → imports from own types, own config, providers/database
domains/*/service   → imports from own repo, own types, own config, providers/*
domains/*/runtime   → imports from own service, own types, providers/*, utils/
```

**Frontend import direction (same principle, different names):**
```
shared/utils/              → imports nothing from the project source tree
shared/lib/                → imports from shared/utils/ only (+ external packages)
shared/components/         → imports from shared/utils/, shared/hooks/, shared/lib/
features/*/types           → external packages + shared/types/ only
features/*/config          → own types
features/*/api             → own types, own config, shared/lib/ (API client)
features/*/hooks           → own api, own types, own config, shared/*
features/*/components      → own hooks, own types, shared/components/, shared/hooks/
features/*/index.ts        → re-exports from own layers only
```

**Domains/features NEVER import from other domains/features.** Shared logic lives in providers (backend) or shared/ (frontend).

## Step 0: Verify required infrastructure

### 0a: Domain mapping script

```bash
find . -maxdepth 3 -name 'map-domains.*' -o -name 'map_domains.*' | grep -v node_modules | grep -v __pycache__
```

**If no domain mapping script is found:** Run `/map-domains` first. It will analyze the codebase and write the mapping script.

### 0b: Lint config with strict overlay support

```bash
find . -maxdepth 2 -name 'eslint.config.*' -o -name '.eslintrc.*' -o -name 'pyproject.toml' -o -name 'ruff.toml' | grep -v node_modules
```

**If no lint config with strict overlay support is found:** Run `/setup-formatter-and-linter $ARGUMENTS` first. It will analyze the codebase, create the lint config with per-domain strict enforcement, and return. Then re-run this skill.

### 0c: Blackbox tests

Check that blackbox tests exist for this domain. If not, tell the user to run `/create-domain-blackbox-tests $ARGUMENTS` first and stop.

### 0d: Test files are read-only in this skill

This skill is for production code refactoring only.

- Do NOT edit, add, rename, move, or delete test files.
- Treat these patterns as read-only:
  - `**/tests/**`
  - `**/*.blackbox.*`
  - `**/*.spec.*`
  - `**/*test*.*`
- If a test appears stale, stop and ask for explicit user approval to run a separate test-update task.

## Step 0b: One-time infrastructure setup

**Skip this step if the codebase already has a `providers/` (or equivalent shared infrastructure) directory.**

This runs ONCE for the entire codebase, on the first domain refactor.

### Pre-seed requirement for `/batch` (parallel workers)

**Before spawning any workers, the coordinator MUST pre-seed all shared files on the parent branch in a single commit.** Workers then branch off that commit and skip Step 0b entirely.

Pre-seed checklist (coordinator-owned, runs once before the batch):
1. Create `domains/`, `providers/`, `utils/` directories (with `.gitkeep`).
2. **Classify and move every existing shared file** from `lib/`, `middleware/`, `helpers/`, `common/`, `shared/` into `providers/` or `utils/` using the rules below.
3. Update ALL imports across the codebase to the new paths.
4. Run type-check + blackbox tests; must be green.
5. Commit + push to the parent branch.

Why this is mandatory: parallel workers that each try to move `shared/types.ts` (or any shared file) into their own domain's `providers/` will produce conflicting moves on the same file. Git cannot auto-resolve "both sides renamed this file to different destinations" — you get a stuck merge and must redo worker outputs manually. Pre-seeding eliminates the race.

### Create the shared infrastructure directories

Analyze the codebase and create the three-tier directory structure:

```
<source-root>/
├── domains/      # Business logic (domain-specific, layered)
├── providers/    # Cross-cutting concerns (shared across domains, has side effects)
└── utils/        # Pure functions (zero side effects, zero project imports)
```

### Classify and move existing shared files

For every file in the existing shared directories (e.g., `lib/`, `middleware/`, `helpers/`, `common/`):

**→ providers/** — anything with side effects, I/O, or external service wrappers:
- Database clients, ORM instances
- Auth middleware
- External API clients (HTTP, gRPC, message queues)
- Logging (writes to stdout/stderr)
- Anything that reads environment variables

**→ utils/** — pure functions with zero side effects AND zero imports from the project:
- String formatting, truncation, template rendering
- Data transformation (no I/O to get the data)
- Constants, enums, type mappings (that don't read env vars)
- Error class definitions
- Functions you could copy-paste into any project and they'd work

**The test:** If you can run the function in a unit test with no mocks, no env vars, no network — it's a util. Everything else is a provider.

### Update ALL imports across the entire codebase

For every source file, update import paths to reflect the new locations. This is mechanical find-and-replace.

### Verify

Run the type checker / compiler with 0 errors, then run the full blackbox test suite.

### Commit separately

This commit is infrastructure only. No business logic changes.

## Step 1: Map the domain

Run the domain mapping script for this domain. Identify the entry file and its transitive import graph. Providers in the graph stay where they are — only the entry file gets decomposed.

## Step 2: Create domain folder

Create the domain directory and ALL layer files. Every domain gets every layer, even if some are small. Consistency is the point — agents always know where to look.

If the domain has no config, create the file with a comment and an empty export.

**Frontend only:** Also create `index.ts` as the public API barrel. This file re-exports only what external consumers (pages, other features via shared state) need. Internal layer files should NOT be imported directly from outside the feature. This is the frontend equivalent of encapsulation — without it, feature boundaries leak.

## Step 3: Extract types

Move from the entry file:
- All validation schemas (Zod, Pydantic, struct definitions)
- All type aliases, interfaces, enums
- All data transfer object definitions

Export everything. Types imports ONLY external packages and provider types (e.g., ORM-generated types).

## Step 4: Extract config

Move from the entry file:
- Magic numbers and string constants
- Default values and limits
- Domain-specific env reads

Config may import from own types only.

## Step 5: Extract repo / data access

Move ALL data access calls from the entry file. Each query becomes a named, exported function.

Rules:
- **Typed args in, typed results out.** Use types from the types layer.
- **No request/response parameters.** Repo is framework-agnostic.
- **Import the data client from providers/** (database, ORM, file system provider).
- **No business logic.** Just data access: find, create, update, delete, count.

**Frontend equivalent (api.ts):** Move all `fetch`, `axios`, React Query `useQuery`/`useMutation` definitions here. Each API call becomes a named, exported hook or function. Rules: no UI rendering, no business logic beyond cache configuration. Import the shared API client from `shared/lib/` — never call `fetch()` directly.

## Step 6: Extract service / business logic

Move business logic from the entry file. Each operation becomes a named, exported function.

Rules:
- **Typed args in, typed results out.** NO request/response objects.
- **Call repo functions for data access.** NEVER import the data client directly.
- **May import providers/** for cross-cutting operations.
- **Throw typed errors** for conditions that map to status codes or error responses.

**Frontend equivalent (hooks.ts):** Move business logic hooks here. These orchestrate API hooks from `api.ts`, manage derived state, and expose clean interfaces to components. Rules: no JSX rendering, no direct API calls (use `api.ts`), no direct store mutations (use shared state hooks).

**For large domains** where the service layer would exceed 300 lines: split into multiple service files by sub-concern. Each follows the same import rules.

## Step 7: Rewrite the runtime layer

The entry file becomes a thin handler. Each handler does ONLY:
1. Parse/validate the request
2. Extract auth context
3. Call a service function with typed args
4. Catch service errors and map to response codes
5. Send the response

Rules:
- No data access imports
- No inline business logic
- No inline validation schemas (import from types)
- Target: under 150 lines. Must stay under 300.

**Frontend equivalent (components/):** Each component does ONLY: receive props or call hooks, render JSX, handle user events by calling hook functions. No direct API calls. No inline business logic. No data transformation beyond simple display formatting.

## Step 8: Update the wiring file

Update the application entry point (server.ts, worker.py, main.go, etc.) to import the domain's handler from the new location. The mount path / registration does NOT change — only the import path.

## Step 9: Delete the old entry file

Remove the original flat file. If its parent directory is now empty, delete it.

## Step 10: Verify import directions

For each file in the new domain folder, verify every import against the allowed imports for its layer. Violations to catch:
- Repo importing from service → move logic down or up
- Service importing request/response types → use typed args
- Runtime importing data client directly → move query to repo
- Any file importing from another domain → extract to a provider

## Step 11: Structural dependency test

Check if a structural test file exists (see `/create-structural-tests`). If not, create it — it auto-discovers all domains.

Run the structural test. It must pass with 0 violations.

## Step 12: Format, lint, and enforce strict rules

### 12a. Run the formatter on all domain files
### 12b. Run the linter with auto-fix (base rules)
### 12c. Add domain files to strict enforcement list in the lint config
### 12d. Run the linter under strict rules — fix every error manually
### 12e. Loop until BOTH formatter check and linter report 0 errors

**Do NOT add lint-disable comments.** Fix the actual code. The only exception is if a fix would change observable behavior — document why and get user approval.

**Do NOT modify prompts, system messages, or any LLM-facing strings.** If a lint rule flags code inside a prompt string, suppress with a disable comment rather than altering the prompt content.

## Step 13: Run blackbox tests

Run the FULL blackbox test suite — the wiring file imports changed, so all domains could be affected.

If tests fail, the refactor introduced a behavior change. **Fix the domain code, not the tests.** The behavior must be identical.

## Step 13b: Enforce no-test-changes gate

Before reporting success, verify no test files were modified by this skill run:

```bash
git diff --name-only | grep -E '(^|/)(tests?/|.*test|.*spec|.*blackbox)' && echo "FAIL: test files changed" && exit 1 || true
```

If this gate fails, the refactor is invalid until test-file changes are removed.

## Step 14: Report

Output:
- Domain folder structure with all layer files
- Import direction verification (pass/fail per file)
- Structural dependency test result
- Blackbox test result
- Linter strict result
- Files deleted (old entry file)
- Any large-domain splits (multiple service files)

Only say **`Domain refactor complete`** if ALL of:
- [ ] Domain folder has all layer files (backend: types/config/repo/service/runtime; frontend: types/api/hooks/components/index.ts)
- [ ] All imports follow forward-only direction rules
- [ ] Old entry file is deleted
- [ ] Wiring file import updated
- [ ] Structural dependency test passes
- [ ] Formatter check passes
- [ ] Linter strict rules pass with 0 errors
- [ ] Blackbox tests pass
