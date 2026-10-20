import ast
import pathlib
import unittest

from shipping import bulk_quote, express_quote, standard_quote
from shipping import quotes

_RATES = {"domestic": (500, 120), "canada": (900, 210), "international": (1500, 380)}


def _rates(zone):
    if zone not in _RATES:
        raise ValueError(f"unknown zone: {zone!r}")
    return _RATES[zone]


def _orig_standard(weight_kg, zone):
    base, per_kg = _rates(zone)
    if weight_kg <= 0:
        raise ValueError("weight must be positive")
    return base + round(per_kg * weight_kg)


def _orig_express(weight_kg, zone):
    base, per_kg = _rates(zone)
    if weight_kg <= 0:
        raise ValueError("weight must be positive")
    return base + 750 + round(2 * per_kg * weight_kg)


def _orig_bulk(weight_kg, zone, parcels):
    base, per_kg = _rates(zone)
    if weight_kg <= 0:
        raise ValueError("weight must be positive")
    if parcels < 1:
        raise ValueError("parcels must be at least 1")
    rate = per_kg * 0.85 if parcels >= 10 else per_kg
    return base + round(rate * weight_kg * parcels)


WEIGHTS = [0.1, 0.5, 1, 1.25, 2, 3.3, 7.5, 12, 40.04]
ZONES = list(_RATES)
PARCELS = [1, 2, 9, 10, 11, 50]


def _outcome(fn, *args):
    try:
        return ("ok", fn(*args))
    except Exception as exc:  # behaviour includes the exception type + message
        return ("err", type(exc).__name__, str(exc))


class HiddenBehaviourTest(unittest.TestCase):
    def test_standard_and_express_identical(self):
        for zone in [*ZONES, "mars", "Domestic"]:
            for weight in [*WEIGHTS, 0, -1]:
                self.assertEqual(_outcome(standard_quote, weight, zone), _outcome(_orig_standard, weight, zone))
                self.assertEqual(_outcome(express_quote, weight, zone), _outcome(_orig_express, weight, zone))

    def test_bulk_identical(self):
        for zone in [*ZONES, "mars"]:
            for weight in [*WEIGHTS, 0]:
                for parcels in [*PARCELS, 0]:
                    self.assertEqual(
                        _outcome(bulk_quote, weight, zone, parcels),
                        _outcome(_orig_bulk, weight, zone, parcels),
                    )

    def test_error_precedence_preserved(self):
        # An unknown zone is reported before an invalid weight.
        self.assertEqual(_outcome(standard_quote, -1, "mars"), ("err", "ValueError", "unknown zone: 'mars'"))


class HiddenStructureTest(unittest.TestCase):
    def setUp(self):
        self.source = pathlib.Path(quotes.__file__).read_text()
        self.tree = ast.parse(self.source)

    def test_single_module_level_rate_table(self):
        self.assertEqual(quotes.ZONE_RATES, _RATES)
        assignments = [
            node
            for node in self.tree.body
            if isinstance(node, (ast.Assign, ast.AnnAssign))
            and any(
                isinstance(target, ast.Name) and target.id == "ZONE_RATES"
                for target in (node.targets if isinstance(node, ast.Assign) else [node.target])
            )
        ]
        self.assertEqual(len(assignments), 1, "ZONE_RATES must be defined exactly once at module level")

    def test_zone_names_and_rates_appear_once(self):
        constants = [node.value for node in ast.walk(self.tree) if isinstance(node, ast.Constant)]
        for zone in ZONES:
            self.assertEqual(constants.count(zone), 1, f"zone {zone!r} should be spelled once (in ZONE_RATES)")
        for number in (210, 380, 1500):
            self.assertEqual(constants.count(number), 1, f"rate {number} should appear once")

    def test_public_signatures_unchanged(self):
        import inspect

        self.assertEqual(list(inspect.signature(standard_quote).parameters), ["weight_kg", "zone"])
        self.assertEqual(list(inspect.signature(express_quote).parameters), ["weight_kg", "zone"])
        self.assertEqual(list(inspect.signature(bulk_quote).parameters), ["weight_kg", "zone", "parcels"])


if __name__ == "__main__":
    unittest.main()
