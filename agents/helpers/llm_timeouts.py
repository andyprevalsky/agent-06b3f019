"""Shared timeout budgets for LLM-backed Temporal activities."""

STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS = 600

# Verifier calls are LLM calls over potentially large context windows. Keep
# their activity wrapper aligned with the normal LLM activity budget so the
# Rose client can enforce its own provider deadline before Temporal kills it.
VERIFIER_ACTIVITY_TIMEOUT_SECONDS = STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS
