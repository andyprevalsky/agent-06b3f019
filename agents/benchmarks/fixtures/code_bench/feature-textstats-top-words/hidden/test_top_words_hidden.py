import unittest

import textstats
from textstats import top_words
from textstats.core import top_words as core_top_words


class HiddenTopWordsTest(unittest.TestCase):
    def test_exported(self):
        self.assertIs(top_words, core_top_words)
        self.assertIn("top_words", textstats.__all__)

    def test_counts_sorted_desc_then_alpha(self):
        text = "b a c b a b d"
        self.assertEqual(top_words(text), [("b", 3), ("a", 2), ("c", 1)])

    def test_ties_alphabetical(self):
        self.assertEqual(top_words("pear apple fig", n=2), [("apple", 1), ("fig", 1)])

    def test_default_n_is_three(self):
        self.assertEqual(len(top_words("a b c d e")), 3)

    def test_uses_tokenizer_rules(self):
        self.assertEqual(top_words("Don't DON'T don't, Stop! stop", n=5), [("don't", 3), ("stop", 2)])

    def test_stopwords_case_insensitive(self):
        text = "The cat and the hat and THE bat"
        self.assertEqual(top_words(text, n=2, stopwords={"The", "AND"}), [("bat", 1), ("cat", 1)])

    def test_fewer_words_than_n(self):
        self.assertEqual(top_words("solo", n=10), [("solo", 1)])
        self.assertEqual(top_words("", n=3), [])

    def test_returns_list_of_tuples(self):
        result = top_words("x y x")
        self.assertIsInstance(result, list)
        self.assertTrue(all(isinstance(item, tuple) for item in result))

    def test_invalid_n(self):
        for bad in (0, -1):
            with self.assertRaises(ValueError):
                top_words("a b", n=bad)


if __name__ == "__main__":
    unittest.main()
