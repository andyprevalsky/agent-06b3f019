Sync with main and create a new branch so we can keep working with the same Conductor chat context.

Steps:
1. **Save the current Conductor workspace name** before switching branches:
   ```bash
   WORKSPACE_NAME=$(sqlite3 ~/Library/Application\ Support/com.conductor.app/conductor.db \
     "SELECT pr_title FROM workspaces WHERE directory_name = '$(basename \"$PWD\")'")
   ```
2. Run `git checkout main && git pull origin main` to sync with the latest main
3. Determine the new branch name by taking the current branch name and appending `-2` (or incrementing the existing suffix number, e.g. `-2` becomes `-3`)
4. Run `git checkout -b <new-branch-name>` to create the new branch from updated main
5. **Restore the Conductor workspace name** so it stays the same across branch changes:
   ```bash
   sqlite3 ~/Library/Application\ Support/com.conductor.app/conductor.db \
     "UPDATE workspaces SET pr_title = '$WORKSPACE_NAME' WHERE directory_name = '$(basename \"$PWD\")'"
   ```
6. Confirm the new branch name to the user
