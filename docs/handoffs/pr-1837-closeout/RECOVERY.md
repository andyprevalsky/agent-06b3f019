# Private recovery

Use the nonsecret receipt JSON files in receipts/ with the existing repository
utility docs/handoffs/whm-b07d9037-preservation/private_archive.py.
Restore each archive into a distinct EMPTY private directory. The tool refuses
overwrites. Its existing managed configuration must be complete; never print,
replace, rotate, request or commit credentials or encryption keys.

Example: agents/venv/bin/python3
docs/handoffs/whm-b07d9037-preservation/private_archive.py restore
--receipt docs/handoffs/pr-1837-closeout/receipts/final-closeout.json
--destination /absolute/new/empty/private/recovery

Verify the exact native receipt, authenticated manifest and compact independent
restore proof before selecting members. The final snapshot is a bounded forensic
cut, with regular-file bytes plus original stat/time mappings. Already-preserved
exact files refer to the authenticated archive carriers in archive-catalog.json.
All carriers must remain available; final-file counts overlap earlier archives.

Never overlay a restored source, database, managed environment, credential,
protected instruction, active ownership/pool claim, fleet registry or cycle onto
a live workspace. Retired operational records are historical evidence only.
The tool's filesystem extraction does not recreate original mtimes, ctimes or
ownership. Producer timestamp bytes and logical metadata remain the authority.

Operation receipts generated after the main snapshot require the separately
identified receipt-tail cut or committed/public durable records. No archive
contains its own future receipt. Later GitHub reviews/merges and the final
published visual are separately durable, linked records, not retroactive members
of an earlier snapshot. The active native root session is preserved only to its
explicit prefix boundary; no claim covers future root messages.

Two historical sandbox obligations of 4,396 cents each and a separate historical
LIVE 100-cent duty remain current execution/financial UNVERIFIED. Recovery grants
no financial, execution, refund, release or mint credit. Never reclaim, reissue
or remint their original cases, bypass their independent auth/root-ACTIVE failures,
or restore old live claims. Preserve Freedom and protected instructions/locks.
