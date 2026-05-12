# ROSE LABS — DATA RETENTION AND DISPOSAL POLICY

**Effective date:** 2026-05-12
**Version:** 1.0
**Owner:** Andy Prevalsky, Founder (security@roselabs.ai)
**Review cadence:** Annually, and ad hoc upon material changes to product scope, data processors, or applicable law.

---

## 1. Purpose

This policy defines how Rose Labs retains, deletes, and disposes of consumer data — including data obtained from third-party integrations such as Plaid. It is designed to comply with the California Consumer Privacy Act (CCPA), the General Data Protection Regulation (GDPR), and applicable U.S. state privacy laws.

## 2. Scope

This policy applies to all consumer personal data and financial account data collected, processed, or stored by Rose Labs, including data retrieved from the Plaid API (account balances, transactions, identity, income, investments, liabilities, and bank statements), as well as data ingested from other connected integrations (Gmail, browser-uploaded sessions) and conversational data created in the product.

## 3. Retention principles

Rose Labs retains consumer data only as long as is necessary to provide the contracted services, comply with legal obligations, resolve disputes, and enforce agreements.

## 4. Retention periods

| Data category                                            | Retention                                                                                                                                                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active consumer account data                             | Retained for the lifetime of the user's active account.                                                                                                                                                  |
| Plaid access tokens and connected account metadata       | Retained for the lifetime of the user's active account; revoked via the Plaid `/item/remove` endpoint immediately upon account deletion or Plaid Link disconnection.                                     |
| Cached Plaid-sourced consumer data (balances, txns, etc.) | Purged within 7 days of Plaid Link disconnection; purged within 30 days of account deletion.                                                                                                            |
| Account closure / deletion request                       | Personal data and connected-integration data are purged from active production systems within 30 days of the verified request.                                                                          |
| Encrypted database backups                                | Rotated out within 90 days of the original deletion event.                                                                                                                                              |
| Application and agent execution logs                      | Backend logs retained per Render defaults. Agent logs retained 7 days in ClickHouse (`observability.fly_logs`). Logs are scrubbed of raw consumer financial data; references are by anonymized user ID. |
| Legally required records (e.g., tax, anti-fraud)          | Retained for the minimum statutory period (typically up to 7 years) and deleted promptly thereafter.                                                                                                    |

## 5. Deletion procedures

- **User-initiated deletion.** Consumers may request deletion at any time by emailing security@roselabs.ai or by using the in-app account-deletion feature. Requests are verified against the requesting user's authenticated identity, acknowledged within 5 business days, and executed within 30 days.
- **Plaid disconnection.** When a consumer disconnects a financial account via Plaid Link or revokes consent, the associated Plaid access token is revoked through the Plaid `/item/remove` endpoint, and the corresponding cached consumer data is purged from active systems within 7 days.
- **Integration disconnection (Gmail, browser sessions, etc.).** When a consumer disconnects a third-party integration, the OAuth credential is revoked and the associated cached data is purged from active systems within 7 days.
- **Disposal of physical media.** Rose Labs operates entirely on cloud infrastructure (Supabase, Render, Fly.io, Vercel) and does not maintain physical storage media containing consumer data. Disposal of underlying physical media is the responsibility of those providers and is governed by their respective SOC 2 / ISO 27001 controls.

## 6. Encryption during retention

All retained consumer data is encrypted at rest using AES-256 (provided by the underlying managed services). Sensitive credentials that grant access to consumer financial data (Plaid access tokens once the Plaid integration ships; Claude Code OAuth credentials and uploaded browser-password credentials today) are additionally encrypted at the application layer using AES-256-GCM with RSA-OAEP-SHA256 envelope encryption prior to storage.

## 7. Third-party processor obligations

Where consumer data is shared with third-party processors (enumerated in the Rose Labs Information Security Policy, §12), Rose Labs requires those processors to honor deletion requests within their own published service-level commitments. LLM providers are accessed under default no-training-on-API-traffic policies; provider-specific zero-retention modes (Anthropic ZDR, OpenAI `store=false`, etc.) will be enabled before the Plaid integration ships.

## 8. Compliance with regulator requests

Rose Labs honors verified rights-to-deletion requests under CCPA, GDPR, and equivalent laws within statutory deadlines (45 days for CCPA, 30 days for GDPR).

## 9. Policy review and updates

This policy is reviewed at least annually by the founder, and ad hoc upon material changes to product scope, data processors, or applicable law. Material updates are version-stamped and communicated to consumers through the Rose Labs Privacy Policy at https://roselabs.ai/privacy.

## 10. Contact

Questions regarding this policy or data-deletion requests should be directed to:

```
security@roselabs.ai
Rose Labs / Andy Prevalsky, Founder
```

---

## Version history

| Version | Date       | Author         | Summary                |
| ------- | ---------- | -------------- | ---------------------- |
| 1.0     | 2026-05-12 | Andy Prevalsky | Initial policy issued. |
