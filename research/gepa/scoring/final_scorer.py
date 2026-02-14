"""Combines critic score with ME/CE/CX structural quality into final GEPA fitness.

Formula: critic × ME^α × CE^β × CX^γ

Multiplicative so that if any structural dimension collapses to 0,
the entire score goes to 0 (ME/CE/CX are necessary conditions, not bonuses).

Default exponents reflect relative importance:
  - CE (β=1.5): coverage is most critical — missing steps means guaranteed failure
  - ME (α=1.0): overlap wastes cost/time but isn't fatal
  - CX (γ=0.5): complexity is the most subjective dimension
"""

import math

# Default exponents — tune on holdout set
ALPHA = 1.0   # ME: mutual exclusivity
BETA = 1.5    # CE: collective exhaustiveness (most important)
GAMMA = 0.5   # CX: complexity invariant (softest signal)


def final_score(
    critic_score: float,
    me_score: float = 1.0,
    ce_score: float = 1.0,
    cx_score: float = 1.0,
    alpha: float = ALPHA,
    beta: float = BETA,
    gamma: float = GAMMA,
) -> float:
    if math.isinf(critic_score) and critic_score < 0:
        return -math.inf
    return critic_score * (me_score ** alpha) * (ce_score ** beta) * (cx_score ** gamma)
