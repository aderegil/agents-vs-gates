import unittest

from analysis.stats import clopper_pearson, fisher_exact, holm, x_of_n


class TestStats(unittest.TestCase):
    def test_clopper_pearson_reference(self):  # spec 14.2
        for (x, n), (lo, hi) in {(0, 10): (0.0, 0.3085), (10, 10): (0.6915, 1.0), (5, 10): (0.1871, 0.8129)}.items():
            got = clopper_pearson(x, n)
            self.assertAlmostEqual(got[0], lo, delta=1e-4)
            self.assertAlmostEqual(got[1], hi, delta=1e-4)

    def test_fisher_reference(self):  # spec 14.2
        self.assertAlmostEqual(fisher_exact(10, 0, 0, 10) / 1.0825e-5, 1.0, delta=1e-3)
        self.assertAlmostEqual(fisher_exact(5, 5, 5, 5), 1.0, delta=1e-9)
        self.assertAlmostEqual(fisher_exact(7, 3, 1, 9), 0.0198, delta=1e-3)  # "7 of 10 vs 1 of 10 -> p ~ 0.02" (spec 1)

    def test_fisher_symmetric(self):
        self.assertAlmostEqual(fisher_exact(2, 8, 6, 4), fisher_exact(6, 4, 2, 8), places=12)

    def test_holm(self):
        self.assertEqual(holm([0.01, 0.04]), [0.02, 0.04])
        self.assertEqual(holm([0.03, 0.02]), [0.04, 0.04])  # monotone
        self.assertEqual(holm({"a": 0.6, "b": 0.7}), {"a": 1.0, "b": 1.0})  # capped

    def test_x_of_n_no_percent_below_20(self):
        self.assertNotIn("%", x_of_n(3, 10))
        self.assertIn("%", x_of_n(10, 20))


if __name__ == "__main__":
    unittest.main()
