Rename the Conductor workspace to the name provided by the user: $ARGUMENTS

Run this command:
```
sqlite3 ~/Library/Application\ Support/com.conductor.app/conductor.db "UPDATE workspaces SET pr_title = '$ARGUMENTS', pr_title_locked = 1 WHERE directory_name = '$(basename "$PWD")'"
```

After running, confirm the rename was successful.
