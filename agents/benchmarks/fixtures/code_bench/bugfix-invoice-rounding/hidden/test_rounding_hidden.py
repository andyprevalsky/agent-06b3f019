import unittest

from invoice import invoice_total, line_total


class HiddenRoundingTest(unittest.TestCase):
    def test_reported_case(self):
        # 7 x 143 = 1001, 5% discount = 50.05 -> 950.95 -> 951
        self.assertEqual(line_total(143, 7, discount_pct=5), 951)

    def test_exact_half_rounds_up(self):
        # 101 at 50% = 50.5 -> 51 (round-half-even would give 50)
        self.assertEqual(line_total(101, 1, discount_pct=50), 51)
        self.assertEqual(line_total(5, 1, discount_pct=10), 5)  # 4.5 -> 5

    def test_below_half_rounds_down(self):
        # 3 x 335 = 1005, 15% = 150.75 -> 854.25 -> 854
        self.assertEqual(line_total(335, 3, discount_pct=15), 854)

    def test_results_are_ints(self):
        self.assertIsInstance(line_total(143, 7, discount_pct=5), int)
        self.assertIsInstance(invoice_total([{"unit_price": 143, "quantity": 7, "discount_pct": 5}], 8.25), int)

    def test_tax_rounding(self):
        lines = [{"unit_price": 143, "quantity": 7, "discount_pct": 5}]
        # 951 * 1.0825 = 1029.4575 -> 1029
        self.assertEqual(invoice_total(lines, tax_rate_pct=8.25), 1029)
        # 1000 + 0.5 -> 1001
        self.assertEqual(invoice_total([{"unit_price": 1000, "quantity": 1}], tax_rate_pct=0.05), 1001)

    def test_tax_applies_to_rounded_line_totals(self):
        lines = [
            {"unit_price": 101, "quantity": 1, "discount_pct": 50},  # 51
            {"unit_price": 5, "quantity": 1, "discount_pct": 10},  # 5
        ]
        # subtotal 56, 10% tax = 5.6 -> 61.6 -> 62
        self.assertEqual(invoice_total(lines, tax_rate_pct=10), 62)

    def test_existing_behaviour_kept(self):
        self.assertEqual(line_total(250, 4), 1000)
        self.assertEqual(invoice_total([{"unit_price": 250, "quantity": 4}]), 1000)


if __name__ == "__main__":
    unittest.main()
