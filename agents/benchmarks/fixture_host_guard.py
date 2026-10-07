"""Scheduling guards for offline fixtures on a shared, busy deploy host.

These guard fixture supervision; production task and native safety budgets stay
in the extracted source. Assertions use completed handoffs and owned resources.
"""

FIXTURE_HOST_GUARD_SECONDS = 600
FIXTURE_DRAIN_SECONDS = 30
