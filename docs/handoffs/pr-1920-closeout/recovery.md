# PR1920 private evidence recovery

`preservation-archives.json` contains authenticated archive receipts and immutable object locators. The archives use the existing project trace bucket and managed AES-GCM key. They contain private logs, source-bound native failure evidence and local-only Git bundles; keep restored members private. Never publish credentials or raw transcripts.

Use the unchanged `private_archive.py` helper referenced by the catalog with existing authoritative project configuration. Verify its SHA256 before use. `verify` authenticates every encrypted frame, stream and member manifest. `restore --receipt <receipt.json> --destination <new-empty-private-directory>` refuses overwrites. The existing `docs/handoffs/pr-1634-closeout/recover_closeout.py` adapter can load the independently managed escrow key and enforce the catalog fingerprint; no new key or credential configuration is required.

The first archive preserves all original supplied semantic traces and local-only branch/stash bundles. Its independent disposable bare-repository restore fetched the exact prerequisites from GitHub and verified the bundle tips; terminal closeout records retain the detailed proof. The cloud archive preserves every regular original campaign file except the live shared Hub directory. Shared Hub custody and subsequent recovery records require the terminal supplement.

Archives preserve evidence and Git history. They grant no test, financial settlement, provider-session release or production credit. Original incomplete native receipts remain incomplete. Final deletion readiness is established separately after production and terminal preservation.
