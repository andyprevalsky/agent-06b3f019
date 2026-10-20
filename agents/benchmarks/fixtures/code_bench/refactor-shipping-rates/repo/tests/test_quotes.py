import unittest

from shipping import bulk_quote, express_quote, standard_quote


class QuotesTest(unittest.TestCase):
    def test_standard(self):
        self.assertEqual(standard_quote(2, "domestic"), 740)

    def test_express(self):
        self.assertEqual(express_quote(1, "canada"), 900 + 750 + 420)

    def test_bulk_discount(self):
        self.assertEqual(bulk_quote(1, "domestic", 10), 500 + 1020)


if __name__ == "__main__":
    unittest.main()
