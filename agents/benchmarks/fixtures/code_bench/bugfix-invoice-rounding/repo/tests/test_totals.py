import unittest

from invoice import invoice_total, line_total


class TotalsTest(unittest.TestCase):
    def test_line_without_discount(self):
        self.assertEqual(line_total(250, 4), 1000)

    def test_line_with_round_discount(self):
        self.assertEqual(line_total(1000, 2, discount_pct=10), 1800)

    def test_invoice_without_tax(self):
        lines = [{"unit_price": 250, "quantity": 4}, {"unit_price": 99, "quantity": 1}]
        self.assertEqual(invoice_total(lines), 1099)


if __name__ == "__main__":
    unittest.main()
