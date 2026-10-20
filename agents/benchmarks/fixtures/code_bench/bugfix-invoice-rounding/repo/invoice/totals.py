"""Invoice arithmetic. Every amount is an integer number of cents.

Finance policy: every computed amount is rounded to the nearest cent, with
exact halves rounded up (ROUND_HALF_UP). This applies to discounted line
totals and to the tax-inclusive invoice total.
"""


def line_total(unit_price, quantity, discount_pct=0):
    """Return a line total in cents after a percentage discount."""
    gross = unit_price * quantity
    discount = gross * discount_pct / 100
    return int(gross - discount)


def invoice_total(lines, tax_rate_pct=0):
    """Return the invoice total in cents: the sum of line totals plus tax."""
    subtotal = sum(line_total(**line) for line in lines)
    tax = subtotal * tax_rate_pct / 100
    return int(subtotal + tax)
