"""Validate saved numeric evidence without rewriting historical scores."""
from __future__ import annotations

import math
from collections.abc import Mapping, Sequence


def is_finite_number(value: object) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        # JSON integers need not fit in a float; treat them as invalid evidence.
        return False


def saved_weighted_score(rows: Sequence[Mapping]) -> float | None:
    """Reproduce the saved formula after individual row numbers are validated."""
    executed = [row for row in rows if row.get("evidence_role", "scored") == "scored"
                and row.get("status") in ("pass", "fail") and row["weight"] > 0]
    try:
        weight = sum(row["weight"] for row in executed)
        if not is_finite_number(weight) or weight <= 0:
            return None
        numerator = sum(row["score"] * row["weight"] for row in executed)
        if not is_finite_number(numerator):
            return None
        return numerator / weight
    except OverflowError:
        # Mixed integer/float sums can overflow before the aggregate is checked.
        return None
