import unittest

from greeting import greet


class GreetTest(unittest.TestCase):
    def test_simple_name(self):
        self.assertEqual(greet("Ada"), "Hello, Ada!")


if __name__ == "__main__":
    unittest.main()
