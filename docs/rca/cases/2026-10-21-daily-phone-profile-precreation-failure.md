# DAILY phone profile initialization failed before live authentication

Status: fixed locally; unchanged live benchmark retry pending.

The new `browser-auth-doordash-cloud-iphone` task failed before root creation in run `2aabb446-046c-4561-bf72-ec1016aa5ee4`. The isolated setup-profile endpoint returned 409. The fixture submitted a new Google identity and its exception authorization in one request, while the server intentionally requires that identity to be configured first. The backend restriction remains unchanged.

The fixture now first configures the identities without an exception, then uses the returned profile revision to authorize the requested exception. Existing matching profiles are untouched. A failed or malformed first receipt cannot authorize the second request. The owning regression reproduced the 409 before the change and passes with both ordered requests.

The same pre-creation error exposed a cleanup classification gap: the batch treated every missing root as an unknown creation outcome even when create was never attempted. The runner now records whether creation was attempted; only an explicit false on an ERROR result permits rootless cleanup. True or missing evidence still fails closed. The owning regression failed on the prior code and passes unchanged after this correction. The failed isolated database independently had zero newly created agents, zero phone leases and zero phone operations; its exact stack was stopped through the existing ownership-checked cleanup function.

Validation: 36 focused tests pass, including both new regressions, existing DAILY checks and the new auth catalog tests. Ruff and diff checks pass. These tests do not establish DoorDash authentication or live phone use.

Earlier startup attempts also lacked the current canonical database fixture. A reviewed prior canonical dump was migrated only with the current ImessageQueue migration, all existing row fingerprints were preserved, schema drift was zero, and dump/restore plus canonical WhatsApp validation passed. No production database was modified. Local private provenance records the source and derived dump hashes.
