Rename the Conductor workspace to the name provided by the user: $ARGUMENTS

Run this command to update the workspace name:
```
sqlite3 ~/Library/Application\ Support/com.conductor.app/conductor.db "UPDATE workspaces SET pr_title = '$ARGUMENTS', pr_title_locked = 1 WHERE directory_name = '$(basename "$PWD")'"
```

Then, find and update the PR title for the current branch:
```
PR_NUMBER=$(gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number')
if [ -n "$PR_NUMBER" ]; then
  gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER" -X PATCH -f title="$ARGUMENTS"
fi
```
(Uses `gh api` instead of `gh pr edit` to avoid the classic projects deprecation error.)

After running, confirm the rename was successful (workspace + PR if applicable).
