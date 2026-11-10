"""Reserve collector capacity in the worker's SQLite store before network I/O."""
import sqlite3
import time
from contextvars import ContextVar
from typing import Any


class BudgetStop(ValueError):
    """Terminate collection without discarding completed immutable captures."""


class RunBudget:
    """A lease-fenced, crash-conservative counter shared by all attempts."""

    def __init__(self, spec: dict[str, Any]) -> None:
        """Use only the database location supplied by the local worker."""
        self.db = sqlite3.connect(spec["database"], timeout=5)
        self.spec = spec

    def reserve(self, unit: str, amount: int = 1, *, partial: bool = False) -> int:
        """Debit before use. Byte reads can reserve a smaller final chunk."""
        self.db.execute("BEGIN IMMEDIATE")
        try:
            job = self.spec["job"]
            if not self.db.execute("SELECT 1 FROM jobs WHERE id=? AND token=? AND status='running'",
                                   (job, self.spec["token"])).fetchone():
                raise BudgetStop("inactive_attempt")
            if time.time() * 1000 >= self.spec["deadline"]:
                raise BudgetStop("seconds")
            row = self.db.execute("SELECT used FROM audit_quota WHERE job=? AND unit=?", (job, unit)).fetchone()
            left = self.spec["limits"][unit] - (row[0] if row else 0)
            if left <= 0 or (left < amount and not partial):
                raise BudgetStop(unit)
            debit = min(amount, left)
            self.db.execute("INSERT INTO audit_quota VALUES(?,?,?) ON CONFLICT(job,unit) DO UPDATE SET used=used+excluded.used",
                            (job, unit, debit))
            self.db.commit()
            return debit
        except BaseException:
            self.db.rollback()
            raise

    def refund(self, unit: str, unused: int) -> None:
        """Return the unused portion of a completed read reservation."""
        with self.db:
            self.db.execute("UPDATE audit_quota SET used=used-? WHERE job=? AND unit=?", (unused,self.spec["job"],unit))


current: ContextVar[RunBudget | None] = ContextVar("collector_budget", default=None)
