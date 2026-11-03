import contextlib
import io
import os
import tempfile
import unittest

from orders import cli
from orders.csv_loader import load_rows, normalize_header
from orders.models import Order

# A fresh copy of the October export (the hidden test does not trust the repo copy).
EXPORT = "SKU,Unit Price , Quantity\nmug-blue,12.50,2\ntee-black,24.00,1\nmug-blue,12.50,3\ncap-red,18.25,4\n"
EXPECTED = "orders: 4\nrevenue: 159.50\n  cap-red: 4\n  mug-blue: 5\n  tee-black: 1\n"


class HiddenDebugTest(unittest.TestCase):
    def _write(self, tmp, content):
        path = os.path.join(tmp, "export.csv")
        with open(path, "w") as handle:
            handle.write(content)
        return path

    def test_cli_report_for_reported_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(tmp, EXPORT)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = cli.main([path])
        self.assertIn(code, (0, None))
        self.assertEqual(out.getvalue(), EXPECTED)

    def test_headers_normalized_to_snake_case(self):
        self.assertEqual(normalize_header("  Unit Price "), "unit_price")
        self.assertEqual(normalize_header("Quantity"), "quantity")
        with tempfile.TemporaryDirectory() as tmp:
            rows = load_rows(self._write(tmp, EXPORT))
        self.assertEqual(set(rows[0]), {"sku", "unit_price", "quantity"})

    def test_snake_case_exports_still_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(tmp, "sku,unit_price,quantity\nmug,2.00,3\n")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                cli.main([path])
        self.assertEqual(out.getvalue(), "orders: 1\nrevenue: 6.00\n  mug: 3\n")

    def test_missing_price_still_fails_loudly(self):
        # Fixing the loader must not mask genuinely missing data downstream.
        with self.assertRaises(KeyError):
            Order({"sku": "mug", "quantity": "1"}).total


if __name__ == "__main__":
    unittest.main()
