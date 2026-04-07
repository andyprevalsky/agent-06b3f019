---
description: "Generate a list of domains and the files they touch. Useful as input for /create-domain-blackbox-tests and /setup-formatter-and-linter."
---

# Map Domains

Map the domains of the target codebase. A domain is a cohesive unit of business logic that can be independently tested, refactored, linted, and reasoned about by an agent.

This skill is the foundation for the entire refactoring pipeline. Its output feeds into:
- `/create-domain-blackbox-tests` — needs the domain's file list to discover entrypoints and boundaries
- `/setup-formatter-and-linter` — needs the domain's file list to know which files to format and enforce strict rules on
- `/refactor-domain-for-full-autonomy` — needs the domain's import graph to decompose it into layers
- `/create-structural-tests` — needs the domain list to auto-discover and verify all domains
- `/audit-providers-and-utils` — needs the domain map to classify shared vs. domain-specific files

## Why this matters

Read the full article at `.context/attachments/pasted_text_2026-04-06_14-17-23.txt` for the foundational thinking. The key insight:

> "Agents are most effective in environments with strict boundaries and predictable structure, so we built the application around a rigid architectural model. Each business domain is divided into a fixed set of layers, with strictly validated dependency directions and a limited set of permissible edges."

Before you can enforce layers, boundaries, or structure, you need to know **what the domains are**. This skill answers that question for any codebase.

## Target architecture

The domain map must identify ALL domain types, not just the obvious entry points. In a layered architecture, the full picture is:

```
<source-root>/
├── utils/        # L0 — pure functions, ZERO project imports
├── providers/    # L1 — cross-cutting side effects, imports utils/ only
├── domains/      # L2 — business logic, each with fixed layer structure
│   ├── <entry-domains>/          # direct entry points (routes, tools, commands, handlers)
│   ├── <support-domains>/        # business logic invoked by other domains (workers, activities, middleware)
│   └── <coordination-domain>/    # dispatches work across domains (workflow engine, router, orchestrator)
└── <app-wiring>  # Composition root — the ONLY file that imports across all domains
```

**Frontend equivalent (React/Next.js/Vite):**
```
<source-root>/
├── shared/       # L0+L1 — reusable code (utils, lib, components, hooks, types)
│   ├── utils/    # Pure functions (cn, formatDate) — zero project imports
│   ├── lib/      # Configured libraries with side effects (API client, Supabase, analytics)
│   ├── components/ # Shared UI kit (Button, Modal, Form)
│   ├── hooks/    # Shared React hooks (useDisclosure, useMediaQuery)
│   └── types/    # Shared TypeScript interfaces
├── features/     # L2 — business logic, each with fixed layer structure
│   ├── <feature>/types.ts        # Zod schemas, TS interfaces
│   ├── <feature>/api.ts          # Data fetching (React Query hooks, HTTP calls)
│   ├── <feature>/hooks.ts        # Business logic orchestration
│   ├── <feature>/components/     # UI rendering
│   └── <feature>/index.ts        # Public API barrel (mandatory)
├── pages/ or app/ # Entry points — compose features
└── App.tsx        # Composition root (provider tree + router)
```

The same import rules apply: features never import from other features, shared code never imports from features.

**Import rules:**
- Domains NEVER import from other domains
- Cross-domain communication goes through providers (a registry, dispatcher, or event bus)
- App wiring (the composition root) is the ONLY file that imports across all domains — for registration and startup

The mapping script must discover ALL domain types so downstream skills have the complete picture.

## Step 0: Check for an existing mapping script

```bash
find . -maxdepth 3 -name 'map-domains.*' -o -name 'map_domains.*' | grep -v node_modules | grep -v __pycache__ | grep -v .git
```

**If a script exists:** skip to Step 3 (run it).

**If no script exists:** continue to Step 1 (analyze the codebase and write one).

## Step 1: Analyze the codebase to define domains

Read the other skills in `.claude/commands/` to understand what downstream consumers need from the domain map:
- `create-domain-blackbox-tests.md` — what it needs to discover per domain
- `setup-formatter-and-linter.md` — what it needs to identify files per domain
- `refactor-domain-for-full-autonomy.md` — what it needs to decompose a domain
- `create-structural-tests.md` — what invariants it enforces across domains
- `audit-providers-and-utils.md` — how it classifies shared vs. domain-specific

Then analyze the codebase to identify:

### 1a. What is a "domain" in this codebase?

A domain is the natural unit of independent work. What counts as a domain depends on the codebase:

| Codebase type | Domain = | Entry point |
|---|---|---|
| REST API | A route prefix and its handlers | Route file (`routes.ts`, `views.py`, `controller.go`) |
| CLI tool | A command and its subcommands | Command handler file |
| Agent/workflow system | A tool, activity, or orchestration unit | Tool class, activity function, workflow definition |
| Library | A public module | Module entry (`__init__.py`, `index.ts`, `mod.rs`) |
| Monolith with MVC | A controller + its model/service | Controller file |
| Event-driven system | An event handler domain | Handler/consumer file |
| Frontend SPA (React/Vue/Svelte) | A feature slice (business capability) | Feature barrel (`index.ts`), page component (`pages/*.tsx`) |

### 1b. Domain types — discover, don't hardcode

Every codebase has multiple categories of domain. The mapping script must discover ALL of them, not just the most obvious. Common patterns:

| Category | What to look for | Examples |
|---|---|---|
| **Entry domains** | Direct entry points that receive external input or user requests | Route handlers, tool classes, CLI commands, event consumers, API controllers |
| **Support domains** | Business logic invoked by entry domains but not direct entry points themselves | Background workers, scheduled jobs, activities, middleware with real logic |
| **Coordination domains** | The layer that dispatches work across entry/support domains | Workflow engine, request router, event bus, orchestrator, job scheduler |

**How to identify types:** Look at the directory structure. Each top-level source directory that contains business logic files (not just utils/config) likely represents a domain category. For example, `routes/`, `tools/`, `commands/` → entry domains. `workers/`, `activities/`, `jobs/` → support domains. `workflows/`, `orchestration/`, `pipeline/` → coordination domains.

**Frontend-specific domain types:**

| Category | What to look for | Examples |
|---|---|---|
| **Entry domains (pages)** | Top-level route components that compose features | `pages/Dashboard.tsx`, `app/routes/settings.tsx` |
| **Support domains (features)** | Self-contained feature slices with their own API/hooks/components | `features/auth/`, `features/billing/`, `features/notifications/` |
| **Coordination domains (router/layout)** | The routing tree or layout shell that wires pages together | `app/router.tsx`, `app/App.tsx`, `pages/_app.tsx` |

Frontend projects often use `features/` instead of `domains/` and `shared/` instead of `providers/`. The mapping script should detect these directory names and treat them as equivalents.

The script should assign a `type` string to each domain based on its category. Derive the type names from the codebase's own terminology (e.g., if the codebase calls them "tools", the type is `"tool"`).

### 1c. Coordination domain — expect a large import graph

Every codebase has at least one coordination domain — the thing that ties the other domains together. Its import graph will be the largest because it currently imports every entry/support domain directly. This is the coupling that the refactor addresses: after refactoring, the coordination domain dispatches through a provider (registry, router, event bus) instead of direct imports.

A large file count on the coordination domain is expected and diagnostic, not a bug.

### 1d. What is "shared infrastructure" (not a domain)?

Shared infrastructure is code imported by multiple domains but not a domain itself. It splits into:

**Providers (side effects, cross-cutting):**
- Database/HTTP/message queue clients
- External API wrappers
- Auth middleware
- Anything that reads env vars or does I/O

**Utils (pure functions):**
- String formatting, truncation
- Data transformation (no I/O)
- Error class definitions
- Math/pricing calculations
- Functions you could run with zero mocks

**The test:** If you can run the function in a unit test with no mocks, no env vars, no network — it's a util. Everything else is a provider.

**App wiring (composition root):**
- The application entry point that registers/wires all domains together
- The ONLY file allowed to import across all domains

The mapping script must identify shared files and classify them so `/audit-providers-and-utils` can sort them into `providers/` vs `utils/`.

**Frontend shared infrastructure mapping:**

| Directory | Backend equivalent | Contents |
|---|---|---|
| `shared/lib/` | `providers/` | Configured library instances with side effects (API client, Supabase, analytics SDK) |
| `shared/utils/` | `utils/` | Pure functions (`cn`, `formatDate`, `debounce`) |
| `shared/components/` | *(no equivalent)* | Reusable UI kit (Button, Modal, Dialog) |
| `shared/hooks/` | *(no equivalent)* | Shared React hooks (`useDisclosure`, `useMediaQuery`) |
| `shared/types/` | types in providers/ | Shared TypeScript types/interfaces |
| `shared/config/` | config files | Environment variables, constants, feature flags |

The provider/util test still applies: if it has side effects (network, storage, analytics), it belongs in `shared/lib/`. If it is a pure function, it belongs in `shared/utils/`.

### 1e. Build the domain list

For each domain, determine:
- **Name** — kebab-case, derived from the file/directory name
- **Type** — derived from the codebase's own domain categories (see 1b)
- **Entry file(s)** — the top-level file(s) for this domain
- **Test file(s)** — any existing test files that cover this domain

## Step 2: Write the mapping script

Write a script at `<codebase-root>/scripts/map_domains.*` (use the codebase's primary language). The script must:

### Required capabilities

1. **DISCOVER** all domain entry points automatically — entry, support, AND coordination domains
2. **PARSE** each file's local import statements using the language's AST or reliable regex
3. **TRACE** the full transitive import graph from each entry point via BFS/DFS
   - Follow local imports only (skip external packages/third-party libraries)
   - Resolve relative paths, index files, and language-specific module resolution
4. **CHECK** whether blackbox test files exist for each domain
5. **CLASSIFY** shared files — files that appear in 2+ domain import graphs
6. **OUTPUT** per-domain: domain name, type, entry file, all transitive files, file count, test existence

**Known limitation:** AST-based import tracing catches all imports (including those inside function bodies) but misses dynamic patterns like `importlib.import_module()`, reflection, or imports gated behind `TYPE_CHECKING`. Files flagged as "orphaned" may actually be used — the `/audit-providers-and-utils` skill investigates these.

### Required modes

The script must support four invocation modes:
- **No args** — summary table grouped by domain type, with file counts and test status
- **`<domain-name>`** — detailed file list for one domain (type, entry, test, all files)
- **`--json`** — machine-readable JSON with domains and shared file classification
- **`--classify`** — shared file analysis showing which files are in multiple domain graphs

### JSON schema

```json
{
  "domains": [
    {
      "domain": "user-auth",
      "type": "entry",
      "entryFile": "src/routes/auth.ts",
      "files": ["src/routes/auth.ts", "src/lib/db.ts", "src/lib/jwt.ts"],
      "testFile": "tests/blackbox/auth.blackbox.ts",
      "fileCount": 8
    },
    {
      "domain": "email-worker",
      "type": "support",
      "entryFile": "src/workers/email.ts",
      "files": ["src/workers/email.ts", "src/lib/smtp.ts"],
      "testFile": "tests/blackbox/email-worker.blackbox.ts",
      "fileCount": 4
    },
    {
      "domain": "request-router",
      "type": "coordination",
      "entryFile": "src/router.ts",
      "files": ["src/router.ts", "src/routes/auth.ts", "src/routes/billing.ts"],
      "testFile": "tests/blackbox/router.blackbox.ts",
      "fileCount": 25
    }
  ],
  "classification": {
    "shared": [
      {"file": "src/lib/db.ts", "usedByCount": 12, "testFile": "tests/blackbox/db.blackbox.ts"}
    ],
    "appWiring": ["src/index.ts"],
    "domainOnly": {"src/routes/auth.ts": "user-auth"},
    "orphaned": ["src/deprecated/old-helper.ts"]
  }
}
```

### Reference implementation

If a reference implementation exists (e.g., `back-end/scripts/map-domains.ts`), read it for patterns. A typical implementation:
- Scans the domain directory (`src/domains/*/`, `src/features/*/`, or whatever the codebase uses) for entry points
- Parses `import`/`from` via regex (include `.tsx` files for frontend codebases)
- BFS-traces the transitive graph
- Checks for existing test files per domain
- Supports all required modes

### Verification

After writing the script, run it and verify:
- Every domain category is represented (entry, support, coordination — or whatever the codebase's equivalents are)
- No domain is missing (compare against a manual `ls` of each entry point directory)
- The import graph for at least 2 domains looks correct (spot-check by reading the files)
- The `--json` mode produces valid JSON with both `domains` and `classification`
- The `--classify` mode shows shared files with their domain usage counts
- The `<domain-name>` mode shows type, entry, test, and full file list

## Step 3: Run the mapping script

Determine the correct invocation for the script's language:
- `.ts` → `npx tsx <script>`
- `.py` → `python <script>`
- `.js` → `node <script>`
- `.sh` → `bash <script>`

If `$ARGUMENTS` is empty, run with no args for the summary:

```bash
<invoke> scripts/map_domains.*
```

If `$ARGUMENTS` contains a domain name, show its detailed file list:

```bash
<invoke> scripts/map_domains.* $ARGUMENTS
```

If `$ARGUMENTS` contains `--json`, output machine-readable JSON:

```bash
<invoke> scripts/map_domains.* --json
```

If `$ARGUMENTS` contains `--classify`, show shared file analysis:

```bash
<invoke> scripts/map_domains.* --classify
```

## Expected output

The output shows:
- Every domain in the codebase, grouped by type
- The full import graph (all local files each domain touches transitively)
- Whether blackbox tests exist for each domain
- File count per domain
- Shared file classification (which files appear in multiple domain graphs)
