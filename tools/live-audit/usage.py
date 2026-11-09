"""Process-local counters enabled only inside a metered pipeline bridge invocation."""
from collections import Counter
from contextvars import ContextVar

usage: ContextVar[Counter[str] | None] = ContextVar("audit_usage", default=None)


def measured(unit: str, amount: int = 1) -> None:
    """Accumulate work in the current bridge invocation."""
    counters = usage.get()
    if counters is not None:
        counters[unit] += amount
