Sync the current branch with the latest main.

Steps:
1. Run `git fetch origin main` to get the latest main
2. Run `git merge origin/main` to merge main into the current branch
3. If there are merge conflicts, resolve them intelligently:
   - Read both sides of every conflict carefully
   - **NEVER discard code from main** in favor of the branch. Main is the source of truth for anything that was merged while this branch was in flight.
   - The goal is to keep ALL code from main AND integrate the branch's changes on top. If the branch modified a section that main also modified, combine both changes.
   - If a conflict is ambiguous and you cannot confidently combine both sides, stop and ask the user before resolving it.
4. After resolving, stage and commit the merge
5. Confirm the result to the user (current branch name, number of new commits pulled in, any conflicts resolved)
