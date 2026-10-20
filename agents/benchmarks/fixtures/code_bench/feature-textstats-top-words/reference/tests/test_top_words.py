import unittest

from textstats import top_words


class TopWordsTest(unittest.TestCase):
    def test_orders_by_count_then_word(self):
        self.assertEqual(top_words("b a c b a b"), [("b", 3), ("a", 2), ("c", 1)])

    def test_stopwords(self):
        self.assertEqual(top_words("the cat THE hat", stopwords={"the"}), [("cat", 1), ("hat", 1)])

    def test_rejects_non_positive_n(self):
        with self.assertRaises(ValueError):
            top_words("a", n=0)


if __name__ == "__main__":
    unittest.main()
