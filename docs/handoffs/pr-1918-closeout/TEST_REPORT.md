# Records-only validation

- Product validation: final source gates and production evidence are retained in the private proof index; original failures remain failures, with recorded handoffs/exceptions.
- Preservation: primary encrypted upload plus full authenticated readback; actual restore into a new empty private directory; independently hashed restored files and imported the restored all-ref Git bundle into a new bare repository.
- Late records: separately encrypted bounded supplement, full authenticated readback and actual full restore with every member hash checked.
- Public records: JSON parsed; exact source scope restricted to this closeout directory; no raw environments, provider payloads, traces, logs or keys committed. Native deletion-check must report READY after the records merge.
- Runtime tests were not rerun for these documentation records. Review disposition follows the canonical CodeRabbit path filters; no-reviewable-paths is not a substantive review PASS.
