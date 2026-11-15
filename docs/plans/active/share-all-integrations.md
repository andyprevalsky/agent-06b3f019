# Share every integration with teams (except iPhone, Browser Cookies, Passwords, Pebble Index 01)

Goal (Andy, 2026-11-15): every connectable integration on the Integrations page can be shared with a team
through the per-account "Share" caption (PR #2097), except iPhone, Browser Cookies, Passwords and Pebble
Index 01. Tests must prove that a teammate's agent can really use each shared integration.

## System fit

```
Integrations page row (per account)          Teams domain (back-end/src/domains/teams)
  "Share" / "Shared with …" caption  ──PUT──▶  shareableProviders.ts: per-provider account listing + grant validation
  (AccountTeamShare, PR #2097)                 TeamIntegrationShare {teamId, integrationId, ownerUserId, provider, accountId, accountEmail}
                                                    │ resolveTeamDataAccess (providers/teamAccess.ts hook)
          ┌─────────────────────────────────────────┼───────────────────────────────────────────────┐
          ▼                                         ▼                                               ▼
  grep (data domain)                     code agents (spawn_agent type=code)              Rose LLM token resolution
  messages: whatsapp, linkedin           github_repo_ref → shared repo (Rose token)        own → TEAM → pool → funded
  documents: granola, fireflies          shared CLI run in the OWNER's sandbox,            (server-side only; never a
  transactions: plaid (explicit scope)   output scrubbed of the owner's secrets            sandbox or Mac)
  team map → agent context (exact ids)
```

## Per-provider semantics

| Provider (Integration.name) | Shareable unit | Grant `accountId` | Agent-facing `account_id` | What a teammate's agent gets |
|---|---|---|---|---|
| gmail | one inbox credential | inbox email | inbox email | grep shared messages (existing) |
| imessage | the single iMessage row | `''` | `''` | grep shared messages (existing) |
| whatsapp | the single WhatsApp row | `''` | `whatsapp` | grep shared WhatsApp messages |
| linkedin | the single LinkedIn row | `''` | `linkedin` | grep shared LinkedIn messages |
| granola / fireflies | the meeting-notes account | `''` + pinned `accountEmail` | `granola` / `fireflies` | grep shared meeting notes, summaries and transcripts |
| plaid | one ACTIVE PlaidItem (institution login) | `PlaidItem.id` | `PlaidItem.id` | grep shared transactions, only with an explicit `team_id`/`owner_user_id` |
| github_repo | one connected repo | `gh:owner/repo` | `gh:owner/repo` | code agents may use the repo (clone, push agent branches); never the owner's linked folder or environment files |
| claude_code / gpt_code | one compute account | compute account id | compute account id | Rose LLM calls may lease the owner's subscription after the reader's own; never a sandbox or Mac token |
| cli | one CLI connection | CLI connection id | CLI connection id | run the owner's CLI server-side in the owner's sandbox; credential files never leave it; output scrubbed |

Not shareable: iPhone, Browser Cookies, the Passwords rows (Apple Passwords, Chrome, Atlas, passkeys) and
Pebble Index 01. Rows that cannot connect today (File System placeholder, Telegram, Messenger, Gemini and the
other coming-soon rows) have no account, so they show no caption.

Every read revalidates the grant at use time: accepted reader and owner membership, the integration still
CONNECTED and owned by the grant owner, and the provider-specific account still present. Revocation, a
disconnected account, a reader dropped to invited or an owner leaving the team removes access at once.

10k agents: no new polling or per-agent fan-out. Grant resolution stays one indexed query per request,
the same as for Gmail today.

## Verification (automated)

- Back-end blackbox: shareable account listing and share/unshare for every provider; data-domain grep per
  provider (shared, private, revoked, disconnected, invited reader); shared GitHub repo resolution; team
  compute lease step; shared CLI run with secret scrubbing.
- Front-end blackbox: a Share caption on every shareable row and none on the excluded rows.
- Agents blackbox: team map and connector gating for every new provider.
- Real agent runs: new benchmark tasks seeded by a new `team_integrations_v1` fixture, run on the cloud fleet
  with `scripts/run-bench <task> --wait`; a teammate's agent must return grounded values from each shared
  integration and nothing from private ones.
