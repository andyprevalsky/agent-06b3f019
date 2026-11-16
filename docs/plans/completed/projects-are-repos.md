# Projects are repos: GitHub Repositories in Integrations, folders in the left bar, project picked at spawn

Andy, 2026-11-15 (round 1):

1. The Integrations "repo" connection must import any project from the user's
   computer, including `.env` files and other local state, through the
   agent-driven CLI flow boxes.dev uses for migration (`dvb agent-init` there,
   `rose agent-init` here).
2. The repo UI must be cohesive with the other Integrations rows; show
   screenshots of better options.
3. Projects are not a left-bar concept. A project (the same thing as a GitHub
   repo) is chosen when a code agent is spawned, so the harness starts the
   right coding environment without the user creating the agent inside it.

Andy, 2026-11-15 (round 2, option A chosen):

- The Rose Mac app provides the `rose` CLI; users never install it.
- Projects must be shareable.
- The left bar keeps FOLDERS (as already shipped), with no mention of projects.
- Import follows boxes.dev's agent-driven setup; local commits are not needed;
  the user's GitHub credential comes along.
- The section is "GitHub Repositories" with no section blurb; "Import from your
  computer" has a short description of what it pulls in.

Andy, 2026-11-15 (round 3): no copy-paste. Import opens the macOS folder picker
and Rose runs the user's own Claude Code or Codex locally, whichever login it
detects (boxes.dev's desktop local-folder setup: agent scan → review → upload).

## How it fits

```
 Left bar: FOLDERS only (Project rows with isFolder; organize agents)
   New folder · folder rows (plain icon, + new agent, subfolders) · Home
   no settings, repo or avatar; a repository that is not a folder is not listed

 Integrations ▸ GITHUB REPOSITORIES (GET /api/projects rows with isRepository,
                                     own + shared by a teammate)
 ├─ repository rows: icon · name · "owner/repo · main · 6 env files · synced 2h ago"
 │    ⚙ → project settings inline (branch, startup script, env files, template
 │        sync, team sharing, re-sync prompt); Remove repository
 │    shared rows: "Shared by <owner> · …", read-only
 ├─ Import from your computer (Rose Mac app only; web: Desktop only + Download)
 │    Mac app: Resources/rose-cli + launcher ~/.rose/bin/rose (ELECTRON_RUN_AS_NODE)
 │    Import → native folder picker (window.api.roseCli.pickProjectFolder)
 │      → `rose import detect`  signed-in local agent: Codex, then Claude Code
 │      → `rose import scan`    one-time code (ROSE_LOGIN_CODE env, unbound or bound
 │                              to the project being synced) → capture → the local
 │                              agent runs READ-ONLY and returns a plan (name, branch,
 │                              env files by NAME, extra files, setup, GitHub access)
 │      → review in Rose (approve; "use my GitHub login on this Mac" when needed)
 │      → `rose import apply`   push (encrypted on the Mac) → github import → verify
 │    events stream over window.api.roseCli.onImportEvent; Cancel kills the run
 │    → repository project (isFolder false) + env files + uncommitted patch;
 │      a GitHub origin (https or SSH) becomes project.repoUrl
 └─ GitHub repo › Connect → GithubRepoConnection + its project (isFolder false)
      chip "@login": the user's GitHub account code agents act as (× removes it)

 Root agent <environment> "# Available projects" (repositories only, + shared)
   - Rose — https://github.com/Rose-Ai-Labs/rose (project <uuid>)
   - billing — https://github.com/acme/billing (project <uuid>) — shared by Tamara (Rose Labs)
 spawn_agent(type='code', github_repo_ref='<project uuid>')
   → exactly that project: checkout (user's own GitHub token when it can push,
     else platform access), env files + startup script (shared: owner's startup
     script, never the owner's env files or token), no-remote: synced bundle
```

10k agents: one owner-scoped project list (plus one indexed share query) per
root turn, capped at 26 entries + total in workflow history; the lazy link of
legacy unlinked repo connections is one indexed query per list.

## Validation criteria

| ID | Criterion | Automated check | Status (2026-11-15, uncommitted) |
|----|-----------|-----------------|--------|
| P1 | Integrations shows a GITHUB REPOSITORIES section in the panel's row style (no blurb); folders are not listed | FE `integrations-projects` + e2e `projects-integrations-flow` | built: FE 10 cases ×5; e2e 1280+390 |
| P2 | Import from your computer: folder picker → local Codex/Claude Code scan → review → apply, no copy-paste; web shows Desktop only + Download for Mac; settings "Sync from your computer" does the same for one project | FE `integrations-projects`, `project-agent-setup`, e2e; mac-app `rose-cli`, `rose-cli-import` (macOS only); back-end `rose import` CLI tests | FE built ×5; CLI live-proven 2026-11-16 with the real agents (`ROSE_IMPORT_LIVE_AGENTS=codex,claude`, `rose-import-live.cases.ts`: Codex 33 s, Claude Code 24 s, valid plans, no secret in output or agent transcripts); mac-app tests written, must run on macOS |
| P3 | An unbound login creates a project with `rose push`; GitHub access via `rose github status/import`; guide follows boxes.dev's steps | back-end `cli-login`, `repo-onboarding`, `github-user-credential` | built ×5 |
| P4 | Connecting a GitHub repo makes it a repository project; removing it disconnects the repo; folder vs repository roles (`isFolder`) incl. dual rows | back-end `projects-repos`, `projects-folder-roles` | built, projects 37/37 ×5 |
| P5 | `github_repo_ref=<project id>` restores exactly that project (owned, shared, no-remote, SSH origin) | back-end `project-workspace-project-ref`, `projects-shared` | built ×5 |
| P6 | `# Available projects` lists repositories (not folders), shared ones marked | agents `github-repo-context` | built 17/17 ×10 |
| P7 | Left bar: folders only, no settings/repo/avatar; repositories that are not folders are not listed; agents in them show under Home | FE `rose-sidebar*`, `projects-sidebar-flow`, `folders-integrations`; e2e | built ×5 |
| P8 | A teammate sees a shared repository (read-only) and their agent can spawn a code agent in it without the owner's env files or token | back-end `projects-shared` + project-workspace case; FE `integrations-projects` | built ×5 |
| P9 | The user's GitHub credential is stored encrypted, never returned, used only for their own sessions (clone, push, `gh`), imported by default whenever the Mac has a `gh` login, visible and removable in Integrations; access through it is never stored as a grant, so removing it denies at once | back-end `github-user-credential`, `code-agent-git-identity`; FE `integrations-projects` | built ×5 |

## Deploy approvals (queued for `/deploy`)

- Prompt text: the `# Available projects` section (header line, "None now"
  line, `— shared by <owner> (<team>)` suffix), the `github_repo_ref` and
  `github_repo_link` descriptions, and the spawn_agent code line.
- Prompt text: the read-only scan prompt `rose import scan` gives the local
  Codex / Claude Code.
- CLI text: `rose import` messages, the new 7-step `rose agent-init` guide, `rose github status` /
  `rose github import` messages, `agent-init status` next steps, the prompt
  location "Integrations › GitHub Repositories › Import from your computer".
- API strings: GitHub credential errors (400/502/409/503/403), "Wait for the
  project sync to finish before removing it" (409), "github_repo_ref names a
  different project than project_id" (400), the private-repo denial (model- and
  user-visible): "Access denied: Rose can't reach the private repository
  {repo}. Import it from your computer in the Rose Mac app, which brings your
  GitHub login." (was "…Please contact support to request access."), and the
  expired-login 401 / rate-limit 429 now point to starting the import again.
- Schema: migration `20261115215734_project_is_folder` (adds
  `Project.isFolder BOOLEAN NOT NULL DEFAULT true`); republish the canonical
  PG15 seed fixture. No Zod request-schema changes.
- The Mac app half ships in this change (Andy, 2026-11-16: mac-app is committed from
  Linux; mac tests that cannot run there are skipped as unverified): `extraResources`
  `scripts/lib/rose-sync` → `Resources/rose-cli`, `main/domains/rose-cli` (the
  `~/.rose/bin/rose` launcher and the import run manager), `window.api.roseCli`
  (`pickProjectFolder`, `importProject`, `onImportEvent`, `cancelImport`; the login code
  reaches the CLI only as `ROSE_LOGIN_CODE`), and `scripts/mac-app-release-decision`
  shipping a Mac release on a `scripts/lib/rose-sync/**` change. Until that release
  installs, the web shows "Desktop only · Download for Mac" for Import from your computer.

## Known limits

- Rose does not import database dumps, files outside the repo, shell rc,
  `~/.gitconfig`, Claude/Codex config (memory files, skills, commands, MCP
  definitions) or thread history; boxes.dev does.
- A shared project is usable via `github_repo_ref`, not an explicit `project_id`.
- The root lists 25 projects (the Temporal activity payload stays bounded), then "+N more
  projects not listed here". A GitHub project beyond them is reachable by its URL; a
  local-only one is not, until it is among the 25 (alphabetical).
- A connect racing a delete of the project it matched can fail once.
