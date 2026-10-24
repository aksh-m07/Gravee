import unittest
from price import discounted


class Acceptance(unittest.TestCase):
    def test_discount(self):
        self.assertEqual(discounted(1000, 20), 800)

    def test_nearest_cent(self):
        self.assertEqual(discounted(999, 15), 849)

    def test_zero_discount(self):
        self.assertEqual(discounted(999, 0), 999)


if __name__ == "__main__":
    unittest.main()
