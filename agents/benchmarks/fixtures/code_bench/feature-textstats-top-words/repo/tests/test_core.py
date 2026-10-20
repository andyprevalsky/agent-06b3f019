import unittest

from textstats import tokenize, word_count


class CoreTest(unittest.TestCase):
    def test_tokenize_lowercases_and_splits(self):
        self.assertEqual(tokenize("Hello, World! Don't stop."), ["hello", "world", "don't", "stop"])

    def test_word_count(self):
        self.assertEqual(word_count("one two  three\nfour"), 4)
        self.assertEqual(word_count(""), 0)


if __name__ == "__main__":
    unittest.main()
