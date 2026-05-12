# ROSE LABS — INFORMATION SECURITY POLICY

**Effective date:** 2026-05-12
**Version:** 1.4
**Owner:** Andy Prevalsky, Founder (security@roselabs.ai)
**Review cadence:** Annually, and ad hoc upon material changes to product scope, infrastructure providers, or applicable law.

---

## 1. Purpose

This policy defines the controls Rose Labs uses to identify, mitigate, and monitor information-security risks across our systems and consumer data, including data obtained from third-party integrations such as Plaid. It applies to all employees, contractors, and systems operated by Rose Labs.

## 2. Scope

This policy covers:

- All production systems operated by Rose Labs (backend API, agent workers, frontend, database, observability).
- All consumer personal data and financial account data collected, processed, or stored — including data retrieved via the Plaid API (balances, transactions, identity, income, investments, liabilities, statements).
- All administrative access to managed-infrastructure providers and processors enumerated in Section 12.

## 3. Roles and responsibilities

- **Founder (Andy Prevalsky):** Owner of this policy. Responsible for production access, vendor selection, security reviews, incident response, and policy review.
- **Engineering contributors:** Required to follow the change-management and access-control practices in this document.
- **Third-party processors:** Required to maintain published security certifications (SOC 2 or equivalent) and to honor deletion requests within their SLAs.

## 4. Risk management

Rose Labs identifies and tracks security risks through the following ongoing activities:

- Review of dependency CVE alerts from GitHub Dependabot (continuous; see §8).
- Review of provider security advisories from Supabase, Render, Fly.io, and Vercel (continuous).
- Annual review of this policy and supporting controls.
- Ad hoc review whenever a new third-party processor is introduced or a new data category is collected.

Material risks are remediated on a defined SLA (Section 8) and tracked through GitHub issues with the `security` label.

## 5. Identity and access management

- **Centralized identity:** Administrative access to production systems and managed providers is gated by Google Workspace SSO where the provider supports SSO, and by per-provider MFA-enforced accounts where it does not. The founder verifies MFA enforcement individually on each managed-provider console.
- **MFA enforcement:** Non-phishing-resistant MFA (Google Prompt / TOTP) is enforced on Google Workspace and propagates to all SSO-integrated providers. Hardware-key / passkey adoption is on the roadmap.
- **Principle of least privilege:** Access to production assets is restricted to the founder. New contributors receive only the access required for their scope of work.
- **Row-level isolation:** Application-layer access is enforced by Supabase Row-Level Security (RLS), enabled on all consumer-data tables, with per-table SELECT policies restricting reads to the owning user. Writes to consumer-data tables are performed exclusively by the backend using the Supabase service-role key after the backend's own authentication middleware verifies the caller's identity; the frontend's anon key cannot write directly to consumer-data tables.
- **Non-human authentication:** Service-to-service authentication between the backend and the agent workers uses a shared backend API key transmitted over TLS; the key is stored in provider-managed secret stores (Render, Fly secrets) and is rotated upon contributor departure or suspected exposure. Scheduled-cadence rotation is on the roadmap. Outbound calls to third-party services use provider-issued OAuth tokens or scoped API keys. Sensitive secrets are encrypted at rest as described in Section 7 and are never written to logs in plaintext.
- **Onboarding / offboarding:** Production credentials are provisioned individually (no shared admin accounts) and revoked immediately upon contributor departure.

## 6. Consumer authentication

Consumers authenticate to Rose Labs via SMS one-time-passcode (OTP) through Twilio Verify. Consumers must successfully complete the OTP challenge before any sensitive flow — including Plaid Link — is reachable. Phone numbers are bound to a single Rose Labs account.

## 7. Data protection

- **Encryption in transit:** TLS 1.2 minimum (TLS 1.3 negotiated where supported by the client) is enforced by our managed hosting providers (Vercel, Render, Supabase, Fly.io); connections below TLS 1.2 are rejected. HTTPS is required for all public endpoints; HSTS is enabled by default by our edge providers.
- **Encryption at rest:** All consumer data — including data retrieved from the Plaid API — is encrypted at rest. The database (Supabase Postgres) and disk-backed services (Render, Fly.io volumes) provide AES-256 encryption at rest by default.
- **Application-layer encryption of credentials that grant access to consumer financial data:** Claude Code OAuth credentials and uploaded browser-password credentials are encrypted at the application layer using AES-256-GCM with envelope encryption (RSA-OAEP-SHA256 wrap of the data key) prior to storage in our database, and are decrypted only inside agent workers at the moment of use (implemented in `back-end/src/providers/claudeCredentials.ts` and `back-end/src/domains/integrations/uploadService.passwords.ts`). The same envelope scheme will be applied to Plaid access tokens before any Plaid integration ships to production; the cryptographic scaffolding is implemented and in active use for the credential types listed above. Other long-lived OAuth tokens (e.g., Gmail) and non-credential browser session data (cookies, localStorage) currently rely on the underlying database's at-rest encryption; extending app-layer encryption to those is on the roadmap.
- **Network separation:** Production and non-production workloads are logically separated by provider account, project, and network namespace. Non-production environments never receive real consumer data.
- **Secret management:** All secrets are stored in provider-managed secret stores (Render env vars, Fly secrets, Vercel env vars, GitHub Actions secrets). Secrets are never committed to source control; `.env` and `.env.*` files are gitignored at the repository root and in each service subdirectory. GitHub secret scanning provides a safety net for public repositories; extending it to private repositories via the GitHub Secret Protection add-on is on the roadmap (see §8).

## 8. Vulnerability management

- **Dependency scanning:** GitHub Dependabot security updates are enabled at the repository level and open pull requests for known CVEs in our software supply chain. A `.github/dependabot.yml` configures version-update PRs across npm, pip, and GitHub Actions ecosystems on a weekly cadence.
- **Secret scanning:** GitHub secret scanning and push protection are configured at the organization level and are active on public repositories (GitHub's free coverage). The primary Rose Labs source repository is private; full secret scanning and push protection on private repositories require the GitHub Secret Protection add-on (or GitHub Advanced Security), which is on the near-term roadmap. In the interim, `.env` and `.env.*` files are gitignored at the repository root and in each service subdirectory, secrets are only stored in provider-managed secret stores (Render, Fly, Vercel, GitHub Actions), and developers are required to review their own diffs for accidental credential exposure before pushing.
- **Patch SLA:**
  - Critical and high-severity vulnerabilities: patched within 7 days.
  - Medium-severity vulnerabilities: patched within 30 days.
  - Low-severity vulnerabilities: patched on the next regular release cadence.
- **End-of-life software:** Node.js, Python, and base container images are tracked against their published support windows and upgraded to current LTS versions on a quarterly cadence. Provider-managed services (Supabase, Render, Fly.io) handle underlying OS and runtime patching.
- **Endpoint scanning:** Employee/contractor laptop MDM and endpoint scanning are on the roadmap and not currently in place.

## 9. Change management

- All production changes flow through GitHub pull requests against the `main` branch.
- Automated checks (lint, type-check, unit tests, integration tests, coverage thresholds) must pass before merge.
- AI-assisted code review (CodeRabbit) flags issues on every PR.
- Production deployments to backend, agents, and frontend are automatic on merge to `main`.
- Database schema changes go through Prisma migrations and are reviewed prior to merge.

## 10. Logging and monitoring

- HTTP request logs (method, path, status, duration) are emitted by the backend and retained.
- Agent execution logs are streamed from Fly.io to ClickHouse and retained for 7 days.
- Errors are logged with stack traces and correlation IDs (agent ID, user ID, request ID) and surfaced for triage.
- Outbound HTTP captures used by our blackbox-test harness redact `Authorization`, `apikey`, `x-api-key`, and similar credential headers before persisting capture entries (`agents/helpers/httpx_capture.py`, `back-end/src/providers/fetchCapture.ts`). A production-grade logging-redaction wrapper covering outbound HTTP credentials and inbound consumer financial-account payloads (Plaid-sourced balances, transactions, identity) is on the roadmap and will be in place before the Plaid integration ships. Until then, developers are required to omit raw credentials and financial payloads from `log.info` / `log.error` extra-context objects at the call site, and `.env*` files plus provider-managed secret stores prevent secrets from being checked in or echoed by services at boot.

## 11. Incident response

- The founder is the primary incident responder and on-call contact (security@roselabs.ai).
- On suspected compromise of consumer data, the response sequence is: (1) contain — revoke affected credentials and rotate secrets; (2) assess scope and root cause; (3) notify affected users and applicable regulators within statutorily required windows (CCPA: 45 days; GDPR: 72 hours where applicable); (4) remediate root cause and document in the post-incident review.
- Plaid will be notified of any incident materially affecting Plaid-sourced consumer data within the timelines required by the Plaid Customer Agreement.

## 12. Vendor and processor management

Rose Labs uses the following third-party processors for consumer data. Processors that handle consumer financial data are not added without published SOC 2 (or equivalent) attestation. New processors are reviewed by the founder against the expected attestations below before being added.

**Infrastructure**

- **Supabase** (Postgres database, auth, realtime, storage) — SOC 2 Type II.
- **Render** (backend API hosting) — SOC 2 Type II.
- **Fly.io** (agent worker hosting) — SOC 2 Type II.
- **Vercel** (frontend hosting, edge) — SOC 2 Type II.

**Communications and identity**

- **Twilio** (SMS OTP via Twilio Verify) — SOC 2, ISO 27001.

**Financial data**

- **Plaid** (financial account aggregation) — SOC 2 Type II.

**LLM inference and AI processing**

User messages and the conversational context required to answer them — which, after the Plaid integration ships, may include data sourced from connected financial accounts — are sent to LLM providers as part of normal agent operation. Each enumerated LLM provider operates under its published no-training-on-API-traffic policy by default. Rose Labs does not currently set additional provider-specific zero-retention flags at the request layer; enabling provider zero-retention modes (Anthropic ZDR, OpenAI `store=false`, etc.) is on the roadmap and will be evaluated before the Plaid integration ships. Users are informed of LLM processing of their data through the Rose Labs Privacy Policy at https://roselabs.ai/privacy and accept it as a condition of account creation. An in-product, per-action consent surface for high-sensitivity flows is on the roadmap.

The LLM and AI providers currently in production use:

- **Anthropic** (Claude family, direct API and OAuth-mediated Claude Code) — SOC 2 Type II; no training on API traffic by default.
- **OpenAI** (text embeddings via `text-embedding-3-small`, and ChatGPT/Codex via OAuth-mediated endpoints) — SOC 2 Type II; no training on API traffic by default.
- **Google** (Gemini family via Google AI / `google-genai` SDK) — SOC 2 Type II; no training on API traffic by default.
- **Perplexity** (Sonar / deep-research API) — SOC 2 Type II; no training on API traffic by default.
- **OpenRouter** (model-routing aggregator) — routes to additional sub-providers including Anthropic, OpenAI, Google, xAI (Grok), Moonshot AI, and Z.ai (GLM); sub-providers are subject to their own attestations.

**Search and enrichment**

- **Exa** (people and web search / enrichment, used by the `message_person` flow) — SOC 2 Type II; no training on API traffic.
- **Perplexity** (already listed under LLM inference above; reiterated here because it is also used as a search/research surface in the deep-research tool).

**Browser automation and sandboxed execution**

- **Browserbase** (managed headless-browser sessions used by the browser-use sub-agent; users authenticate to third-party sites through these sessions) — SOC 2 Type II.
- **Steel** (managed headless-browser sessions; alternate / future provider in the same role as Browserbase).
- **E2B** (sandboxed execution environment for Claude Code; receives decrypted Claude Code OAuth credentials at the moment of use, never written to disk in plaintext outside the sandbox) — SOC 2 Type II.

**Payments**

- **Stripe** (subscription billing and payment processing for Rose Labs services) — PCI DSS Level 1, SOC 1 Type II, SOC 2 Type II.

**Other AI/data services with provisioned keys** (disclosed for completeness; activation requires founder review):

- **Parallel AI** (Find All / Enrich / Monitor APIs) — credentials provisioned, no current production code path against consumer financial data; activation against Plaid-sourced data requires founder review and SOC 2 confirmation.
- **Supermemory** (long-term memory store) — credentials provisioned, no current production code path against consumer financial data; activation against Plaid-sourced data requires founder review and SOC 2 confirmation.
- **Cursor** (helper code present, blackbox-test usage only today; no production code path).
- **Vercel API** (deployment automation only; does not receive consumer data).

**Observability**

- **ClickHouse Cloud** (retained agent log storage) — SOC 2 Type II; retention 7 days.

**Source control and supply chain**

- **GitHub** (source control, Dependabot, secret scanning, Actions) — SOC 2 Type II.

## 13. Data retention and deletion

Data retention, deletion, and disposal practices are defined in the separate **Rose Labs Data Retention and Disposal Policy**, which is incorporated by reference into this policy.

## 14. Employee security awareness

All contributors are required to:

- Use Google Workspace SSO with MFA for all production access where the provider supports SSO; otherwise use per-provider MFA-enforced accounts.
- Use unique, password-manager-generated credentials for all accounts.
- Encrypt laptop disks (FileVault on macOS).
- Report suspected security incidents to security@roselabs.ai immediately.

Formal security-awareness training is on the roadmap and will be rolled out as the team grows beyond the founder.

## 15. Policy review and updates

This policy is reviewed at least annually by the founder, and ad hoc upon material changes to product scope, infrastructure providers, or applicable law. Version history is maintained in this document and in the source repository (`docs/legal/information-security-policy.md`). Material changes are communicated to consumers through the Rose Labs Privacy Policy at https://roselabs.ai/privacy.

## 16. Contact

Questions regarding this policy, security concerns, or vulnerability reports should be directed to:

```
security@roselabs.ai
Rose Labs / Andy Prevalsky, Founder
```

---

## Version history

| Version | Date       | Author         | Summary                                                                                                                                                                                                                                                                                                                |
| ------- | ---------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1.0     | 2026-05-12 | Andy Prevalsky | Initial policy issued.                                                                                                                                                                                                                                                                                                  |
| 1.1     | 2026-05-12 | Andy Prevalsky | Expanded LLM/AI processor list (added OpenAI, Google, Perplexity, OpenRouter sub-providers). Rewrote LLM-data-handling language to reflect that LLM processing is core product behavior, disclosed in the Privacy Policy. Scoped app-layer encryption claim to credentials. Softened TLS 1.3, logging-redaction claims. |
| 1.2     | 2026-05-12 | Andy Prevalsky | Scoped app-layer encryption to credential types that exist today (Claude Code + uploaded passwords); framed Plaid token encryption as scaffolding ready, pending integration. Removed false zero-retention-endpoint claim; reframed as roadmap. Scoped logging redaction to blackbox-capture harness today, production wrapper to roadmap. Softened service-key rotation language. Corrected OpenRouter sub-provider list (dropped Mistral, added Z.ai/GLM).                                                                                                                                                                                                                                                                                                |
| 1.3     | 2026-05-12 | Andy Prevalsky | Added missing processors to §12 (Exa, Browserbase, Steel, E2B, Stripe, Parallel AI, Supermemory, Cursor, Vercel API) with active vs. provisioned-only dispositions. Tightened §5 RLS language to reflect SELECT-only policies + service-role writes. Aligned §7/§8 secret-management wording with corrected `.env*` gitignore behavior. Added supporting artifacts: `.github/dependabot.yml` and `docs/legal/data-retention-policy.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 1.4     | 2026-05-12 | Andy Prevalsky | Corrected §8 secret-scanning claim: org-level configuration is active on public repos (GitHub free tier); private-repo coverage via GitHub Secret Protection add-on is on the near-term roadmap. Updated §7 to match.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
