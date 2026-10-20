import os
import tempfile
import unittest

from orders.csv_loader import load_rows
from orders.models import Order
from orders.report import build_report, render


class ReportTest(unittest.TestCase):
    def test_snake_case_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "orders.csv")
            with open(path, "w") as handle:
                handle.write("sku,unit_price,quantity\nmug,2.00,3\n")
            report = build_report([Order(row) for row in load_rows(path)])
        self.assertEqual(render(report), "orders: 1\nrevenue: 6.00\n  mug: 3")


if __name__ == "__main__":
    unittest.main()
