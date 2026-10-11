"""Exact small-sample statistics, standard library only (spec 14.2).

- clopper_pearson(x, n): exact binomial CI by bisection on the binomial CDF.
- fisher_exact(a, b, c, d): two-sided Fisher exact test on [[a, b], [c, d]] (sum of tables with p <= observed).
- holm(pvals): Holm-Bonferroni adjusted p-values (monotone, capped at 1).
"""
from __future__ import annotations

from math import comb, lgamma, exp, log


def binom_cdf(k: int, n: int, p: float) -> float:
    """P(X <= k) for X ~ Bin(n, p)."""
    if k < 0:
        return 0.0
    if k >= n:
        return 1.0
    if p <= 0.0:
        return 1.0
    if p >= 1.0:
        return 0.0
    lp, lq = log(p), log(1.0 - p)
    return min(1.0, sum(exp(log(comb(n, i)) + i * lp + (n - i) * lq) for i in range(k + 1)))


def _bisect(f, lo: float = 0.0, hi: float = 1.0, iters: int = 100) -> float:
    """Root of a monotone decreasing f on [lo, hi] (f(lo) >= 0 >= f(hi))."""
    for _ in range(iters):
        mid = (lo + hi) / 2
        if f(mid) > 0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def clopper_pearson(x: int, n: int, alpha: float = 0.05) -> tuple[float, float]:
    if n <= 0:
        return (0.0, 1.0)
    if not 0 <= x <= n:
        raise ValueError(f"x={x} outside 0..{n}")
    a2 = alpha / 2
    # lower: P(X >= x | p) = a2  <=>  1 - cdf(x-1, p) = a2 ; increasing in p
    lo = 0.0 if x == 0 else _bisect(lambda p: a2 - (1.0 - binom_cdf(x - 1, n, p)))
    # upper: P(X <= x | p) = a2 ; decreasing in p
    hi = 1.0 if x == n else _bisect(lambda p: binom_cdf(x, n, p) - a2)
    return (lo, hi)


def _hypergeom_logp(a: int, r1: int, c1: int, n: int) -> float:
    def lc(nn, kk):
        return lgamma(nn + 1) - lgamma(kk + 1) - lgamma(nn - kk + 1)
    return lc(r1, a) + lc(n - r1, c1 - a) - lc(n, c1)


def fisher_exact(a: int, b: int, c: int, d: int) -> float:
    """Two-sided p for the 2x2 table [[a, b], [c, d]]."""
    r1, c1, n = a + b, a + c, a + b + c + d
    if n == 0:
        return 1.0
    lo, hi = max(0, c1 - (n - r1)), min(r1, c1)
    p_obs = _hypergeom_logp(a, r1, c1, n)
    total = 0.0
    for k in range(lo, hi + 1):
        lp = _hypergeom_logp(k, r1, c1, n)
        if lp <= p_obs + 1e-7:  # relative tolerance on the log scale
            total += exp(lp)
    return min(1.0, total)


def holm(pvals):
    """Holm step-down adjustment. Accepts a list (returns list) or a dict (returns dict with the same keys)."""
    if isinstance(pvals, dict):
        keys = list(pvals)
        adj = holm([pvals[k] for k in keys])
        return dict(zip(keys, adj))
    m = len(pvals)
    order = sorted(range(m), key=lambda i: pvals[i])
    out = [0.0] * m
    running = 0.0
    for rank, i in enumerate(order):
        val = min(1.0, (m - rank) * pvals[i])
        running = max(running, val)
        out[i] = running
    return out


def fmt_ci(ci: tuple[float, float]) -> str:
    return f"[{ci[0]:.3f}, {ci[1]:.3f}]"


def x_of_n(x: int, n: int, *, pct_min_n: int = 20) -> str:
    """'x of N [lo, hi]' — percentages only when N >= 20 (spec 14.1)."""
    if n == 0:
        return "0 of 0"
    s = f"{x} of {n} {fmt_ci(clopper_pearson(x, n))}"
    if n >= pct_min_n:
        s += f" ({100 * x / n:.0f}%)"
    return s
