Sync the current branch with the latest main.

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
5. Resync the local database from production by running `bash scripts/setup-db.sh`
   - This refreshes the workspace Postgres schema and synced production data, including credentials that local smoke/deploy tests read from the DB.
   - If `CONDUCTOR_PORT` or `CONDUCTOR_WORKSPACE_NAME` is missing, stop and tell the user `/sync` must be run from a Conductor workspace.
6. Confirm the result to the user (current branch name, number of new commits pulled in, any conflicts resolved, whether local main was updated, whether the DB resync completed)
