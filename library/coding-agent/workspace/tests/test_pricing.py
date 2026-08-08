import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pricing import line_total, order_total


class LineTotalTest(unittest.TestCase):
    def test_multiplies_and_rounds(self):
        self.assertEqual(line_total(19.99, 3), 59.97)


class OrderTotalTest(unittest.TestCase):
    def test_no_discount(self):
        self.assertEqual(order_total([(10.0, 2), (5.0, 1)]), 25.0)

    def test_ten_percent_off(self):
        # 20.00 subtotal, ten percent off -> 18.00
        self.assertEqual(order_total([(10.0, 2)], discount_percent=10), 18.0)


if __name__ == "__main__":
    unittest.main()
