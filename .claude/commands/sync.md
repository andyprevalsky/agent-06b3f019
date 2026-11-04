Sync the current branch with the latest main.

## During an active deploy

A sync is an integration boundary, not a reason to stop all validation or erase
its evidence. Read `.claude/commands/deploy.md` → **Sync without restarting the
whole deploy** before changing a checkout or database used by a running gate.

- Fetch and inspect the incoming diff first. Identify the actual checkout,
  database, dependency directory and shared resources that the sync would change.
- Let healthy work on isolated, unchanged inputs continue. Do not cancel a whole
  cohort, wait for an unrelated owner, or discard a receipt merely because main
  advanced. Each result still belongs to the exact source it tested.
- Merge at a safe boundary for the checkout being changed. Do not edit its source
  or replace its dependencies underneath a running test, build or reviewer.
- Refresh only changed dependency inputs. Resync the local database only after
  every consumer of that database has finished; tests using other databases keep
  running. If the code merge can finish first, record the database refresh as
  pending and complete it at that boundary. Do not report the entire `/sync`
  complete while its required database refresh remains pending.
- Replan from the merged tree, preserving the originally selected coverage and
  all failures, cleanup obligations and qualified exceptions. Use only the
  runner's supported exact-input/scoped reuse; an old PASS is not automatically
  a PASS on new code. The final current-source verification is still required.

Steps:
1. Run `git fetch origin main` to get the latest main
2. Update local `main` to match `origin/main` so it doesn't fall behind:
   - If the current branch IS `main`: run `git pull --ff-only origin main`, then skip to step 5.
   - Otherwise: run `git update-ref refs/heads/main refs/remotes/origin/main` (safe fast-forward of local main without checking it out). If local main has diverged from origin/main (not a fast-forward), skip this update and warn the user.
3. Run `git merge origin/main` to merge main into the current branch
4. If there are merge conflicts, resolve them intelligently:
   - Read both sides of every conflict carefully
   - **NEVER discard code from main** in favor of the branch. Main is the source of truth for anything that was merged while this branch was in flight.
   - The goal is to keep ALL code from main AND integrate the branch's changes on top. If the branch modified a section that main also modified, combine both changes.
   - If a conflict is ambiguous and you cannot confidently combine both sides, stop and ask the user before resolving it.
   - After resolving, stage and commit the merge
5. At the database's safe boundary, resync it from production by running `bash scripts/setup-db.sh`
   - This refreshes the workspace Postgres schema and synced production data, including credentials that local smoke/deploy tests read from the DB.
   - If `CONDUCTOR_PORT` or `CONDUCTOR_WORKSPACE_NAME` is missing, stop and tell the user `/sync` must be run from a Conductor workspace.
6. Confirm the result to the user (current branch name, number of new commits pulled in, any conflicts resolved, whether local main was updated, whether the DB resync completed). During a deploy, also state which validation remained valid, which inputs changed and which checks actually require execution on the merged source. A pending database refresh is a pending step, not a reason to idle unrelated work.
