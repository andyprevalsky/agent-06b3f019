---
description: "Generate a list of backend domains and the files they touch. Useful as input for /create-domain-blackbox-tests and /setup-formatter-and-linter."
---

# Map Domains

Run the domain mapping script and display the results.

```bash
cd back-end && npx tsx scripts/map-domains.ts
```

If `$ARGUMENTS` contains a domain name, show its detailed file list:

```bash
cd back-end && npx tsx scripts/map-domains.ts $ARGUMENTS
```

If `$ARGUMENTS` contains `--json`, output machine-readable JSON:

```bash
cd back-end && npx tsx scripts/map-domains.ts --json
```

The output shows:
- Every route-based domain in `back-end/src/routes/`
- The full import graph (all local files the domain touches)
- Whether blackbox tests exist for that domain
- File count per domain
