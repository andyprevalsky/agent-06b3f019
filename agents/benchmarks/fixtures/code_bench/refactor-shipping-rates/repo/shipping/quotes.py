"""Shipping quotes in integer cents."""


def standard_quote(weight_kg, zone):
    """Ground shipping: base fee plus a per-kilogram charge."""
    if zone == "domestic":
        base, per_kg = 500, 120
    elif zone == "canada":
        base, per_kg = 900, 210
    elif zone == "international":
        base, per_kg = 1500, 380
    else:
        raise ValueError(f"unknown zone: {zone!r}")
    if weight_kg <= 0:
        raise ValueError("weight must be positive")
    return base + round(per_kg * weight_kg)


def express_quote(weight_kg, zone):
    """Express shipping: double the standard per-kilogram charge, flat 750 surcharge."""
    if zone == "domestic":
        base, per_kg = 500, 120
    elif zone == "canada":
        base, per_kg = 900, 210
    elif zone == "international":
        base, per_kg = 1500, 380
    else:
        raise ValueError(f"unknown zone: {zone!r}")
    if weight_kg <= 0:
        raise ValueError("weight must be positive")
    return base + 750 + round(2 * per_kg * weight_kg)


def bulk_quote(weight_kg, zone, parcels):
    """Bulk shipping: one base fee, per-kilogram charge 15% off for 10+ parcels."""
    if zone == "domestic":
        base, per_kg = 500, 120
    elif zone == "canada":
        base, per_kg = 900, 210
    elif zone == "international":
        base, per_kg = 1500, 380
    else:
        raise ValueError(f"unknown zone: {zone!r}")
    if weight_kg <= 0:
        raise ValueError("weight must be positive")
    if parcels < 1:
        raise ValueError("parcels must be at least 1")
    rate = per_kg * 0.85 if parcels >= 10 else per_kg
    return base + round(rate * weight_kg * parcels)
