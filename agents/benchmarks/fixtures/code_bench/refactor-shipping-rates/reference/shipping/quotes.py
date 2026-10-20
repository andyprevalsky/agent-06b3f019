"""Shipping quotes in integer cents."""

ZONE_RATES = {
    "domestic": (500, 120),
    "canada": (900, 210),
    "international": (1500, 380),
}


def _zone_rates(zone, weight_kg):
    if zone not in ZONE_RATES:
        raise ValueError(f"unknown zone: {zone!r}")
    if weight_kg <= 0:
        raise ValueError("weight must be positive")
    return ZONE_RATES[zone]


def standard_quote(weight_kg, zone):
    """Ground shipping: base fee plus a per-kilogram charge."""
    base, per_kg = _zone_rates(zone, weight_kg)
    return base + round(per_kg * weight_kg)


def express_quote(weight_kg, zone):
    """Express shipping: double the standard per-kilogram charge, flat 750 surcharge."""
    base, per_kg = _zone_rates(zone, weight_kg)
    return base + 750 + round(2 * per_kg * weight_kg)


def bulk_quote(weight_kg, zone, parcels):
    """Bulk shipping: one base fee, per-kilogram charge 15% off for 10+ parcels."""
    base, per_kg = _zone_rates(zone, weight_kg)
    if parcels < 1:
        raise ValueError("parcels must be at least 1")
    rate = per_kg * 0.85 if parcels >= 10 else per_kg
    return base + round(rate * weight_kg * parcels)
