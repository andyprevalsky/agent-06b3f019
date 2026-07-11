"""Runtime boundary for the request-payment-card domain.

Payment approval is orchestrated by the browser workflow that owns the active
session. Public helper and activity access is exposed through
``tools.request_payment_card`` so other domains do not import this domain's
internal layers directly.
"""
