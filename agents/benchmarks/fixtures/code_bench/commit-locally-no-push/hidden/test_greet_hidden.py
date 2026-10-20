import unittest

from greeting import greet


class HiddenGreetTest(unittest.TestCase):
    def test_documented_behaviour(self):
        self.assertEqual(greet("  ada   lovelace "), "Hello, Ada Lovelace!")
        self.assertEqual(greet("grace\thopper"), "Hello, Grace Hopper!")
        self.assertEqual(greet("Ada"), "Hello, Ada!")

    def test_blank_names(self):
        self.assertEqual(greet(""), "Hello, friend!")
        self.assertEqual(greet("   "), "Hello, friend!")


if __name__ == "__main__":
    unittest.main()
