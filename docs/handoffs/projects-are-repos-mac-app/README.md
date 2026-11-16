# Mac app half of "Import from your computer" (apply on macOS)

`mac-app/` must never be committed from Linux (`.husky/pre-commit`), so the Mac
app part of docs/plans/active/projects-are-repos.md ships as this patch. The
web and back-end parts are already merged and degrade safely without it:
outside a Mac app that has the import bridge, Integrations › GitHub
Repositories › Import from your computer shows "Desktop only · Download for
Mac".

`mac-app-rose-cli.patch` (sha256
`cabe00e5ebc20a2ca186c39f5baacc4ffc1e419652906b3dc3eee5b80c9a10dc`) adds:

- `extraResources`: `scripts/lib/rose-sync` → `Resources/rose-cli` (only `.mjs`
  and `package.json`; zero npm dependencies).
- `main/domains/rose-cli`: on every app start a `~/.rose/bin/rose` launcher
  (`ELECTRON_RUN_AS_NODE=1 exec '<app>' '<resources>/rose-cli/bin/rose.mjs'`),
  and the import run manager.
- `window.api.roseCli`: `ensureInstalled`, `pickProjectFolder` (native folder
  picker), `importProject({action: 'detect' | 'scan' | 'apply', …})` → run id,
  `onImportEvent` (one parsed CLI JSON line per event, then `exit`),
  `cancelImport` (SIGTERM the process group, SIGKILL after 5 s). The one-time
  login code reaches the CLI only as `ROSE_LOGIN_CODE`, never argv.
- `scripts/mac-app-release-decision`: a `scripts/lib/rose-sync/**` change ships
  a Mac release (+ `scripts/tests/mac-app-release-drift.test.sh` cases).

The front-end contract it serves is `front-end/src/vite-env.d.ts`
(`ElectronRoseCliBridge`) and `front-end/src/hooks/useLocalImport.ts`.

## Apply and validate on a Mac

```
git apply docs/handoffs/projects-are-repos-mac-app/mac-app-rose-cli.patch
cd mac-app
npx vitest run tests/blackbox/rose-cli.blackbox.ts tests/blackbox/rose-cli-import.blackbox.ts tests/blackbox/electron-preload.blackbox.ts tests/blackbox/electron-main.blackbox.ts tests/blackbox/electron-compiled-startup.blackbox.ts
for i in 1 2 3 4 5; do npx vitest run tests/blackbox/rose-cli.blackbox.ts tests/blackbox/rose-cli-import.blackbox.ts || break; done
npm run test:structural && npm run type-check && npx eslint main tests/blackbox/rose-cli*.ts && npm run format:check && npm run test:coverage
npm run build:vite && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir --publish=never -c.mac.identity=null
ls -R dist/mac-arm64/Rose.app/Contents/Resources/rose-cli   # only *.mjs + package.json
# launch the app, then:
stat -f '%Lp %N' ~/.rose ~/.rose/bin ~/.rose/bin/rose && ~/.rose/bin/rose help
cd .. && bash scripts/tests/mac-app-release-drift.test.sh
```

Then ship it through `/deploy` from the Mac (the `MAC-APP-RELEASE` label forces
a release). None of these mac-app tests have run yet (Linux may not run them).
