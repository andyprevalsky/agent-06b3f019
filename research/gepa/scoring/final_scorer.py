"""Combines critic score, soft penalties, and regularizers into final GEPA fitness."""

import math


def final_score(
    critic_score: float,
    penalties: float,
    num_tasks: int,
    depth: int,
    lambda_size: float = 0.02,
    lambda_depth: float = 0.01,
) -> float:
    if math.isinf(critic_score) and critic_score < 0:
        return -math.inf
    return critic_score - penalties - lambda_size * num_tasks - lambda_depth * depth
