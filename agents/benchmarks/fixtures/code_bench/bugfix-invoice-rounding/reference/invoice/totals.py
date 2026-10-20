"""Invoice arithmetic. Every amount is an integer number of cents.

Finance policy: every computed amount is rounded to the nearest cent, with
exact halves rounded up (ROUND_HALF_UP). This applies to discounted line
totals and to the tax-inclusive invoice total.
"""

from decimal import ROUND_HALF_UP, Decimal


def _round_cents(value):
    return int(Decimal(value).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def line_total(unit_price, quantity, discount_pct=0):
    """Return a line total in cents after a percentage discount."""
    gross = Decimal(unit_price) * Decimal(quantity)
    discount = gross * Decimal(str(discount_pct)) / 100
    return _round_cents(gross - discount)


def invoice_total(lines, tax_rate_pct=0):
    """Return the invoice total in cents: the sum of line totals plus tax."""
    subtotal = Decimal(sum(line_total(**line) for line in lines))
    tax = subtotal * Decimal(str(tax_rate_pct)) / 100
    return _round_cents(subtotal + tax)
