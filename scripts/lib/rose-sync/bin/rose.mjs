#!/usr/bin/env node
// `rose` CLI entry point (package.json "bin"). Same commands as scripts/rose-sync:
// agent-init, status, push, onboard, seed-rose. Run `rose help` for usage.
import { main } from "../cli.mjs";

main(process.argv.slice(2), { cli: "rose" })
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `rose: ${err && err.message ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
