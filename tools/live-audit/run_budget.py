"""Reserve collector capacity in the worker's SQLite store before network I/O."""
import sqlite3
import threading
import time
from contextlib import contextmanager
from contextvars import ContextVar
from http.client import HTTPResponse
from typing import Any, Iterator


class BudgetStop(ValueError):
    """Terminate collection without discarding completed immutable captures."""


class RunBudget:
    """A lease-fenced, crash-conservative counter shared by concurrent downloads."""

    def __init__(self, spec: dict[str, Any]) -> None:
        """Serialize SQLite access and share prepaid byte capacity across fetch threads."""
        self.db = sqlite3.connect(spec["database"], timeout=5, check_same_thread=False)
        self.spec = spec
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.byte_credit = 0
        self.active_reads = 0
        self.downloaders = 0

    def _check_lease(self) -> None:
        """Verify the active worker and deadline with the connection lock held."""
        if not self.db.execute("SELECT 1 FROM jobs WHERE id=? AND token=? AND status='running'",
                               (self.spec["job"], self.spec["token"])).fetchone():
            raise BudgetStop("inactive_attempt")
        if time.time() * 1000 >= self.spec["deadline"]:
            raise BudgetStop("seconds")

    def reserve(self, unit: str, amount: int = 1, *, partial: bool = False) -> int:
        """Debit before use, or check available capacity without writing for zero."""
        with self.lock:
            if amount:
                self.db.execute("BEGIN IMMEDIATE")
            try:
                self._check_lease()
                if unit == "network_bytes" and amount == 0 and (self.byte_credit or self.active_reads):
                    return 0
                job = self.spec["job"]
                row = self.db.execute("SELECT used FROM audit_quota WHERE job=? AND unit=?", (job, unit)).fetchone()
                left = self.spec["limits"][unit] - (row[0] if row else 0)
                if left <= 0 or (left < amount and not partial):
                    raise BudgetStop(unit)
                debit = min(amount, left)
                if debit:
                    self.db.execute("INSERT INTO audit_quota VALUES(?,?,?) ON CONFLICT(job,unit) DO UPDATE SET used=used+excluded.used",
                                    (job, unit, debit))
                    self.db.commit()
                return debit
            except BaseException:
                self.db.rollback()
                raise

    @contextmanager
    def downloader(self) -> Iterator[None]:
        """Refund unspent prepaid bytes when the last active downloader closes."""
        with self.lock:
            self.downloaders += 1
        try:
            yield
        finally:
            with self.lock:
                self.downloaders -= 1
                if not self.downloaders and self.byte_credit:
                    with self.db:
                        self.db.execute("UPDATE audit_quota SET used=used-? WHERE job=? AND unit='network_bytes'",
                                        (self.byte_credit, self.spec["job"]))
                    self.byte_credit = 0

    def read(self, response: HTTPResponse, maximum: int) -> bytes:
        """Fence every read while amortizing durable debits across a MiB of body reads."""
        with self.changed:
            self._check_lease()
            while not self.byte_credit:
                try:
                    self.byte_credit = self.reserve("network_bytes", 1024 * 1024, partial=True)
                except BudgetStop as error:
                    # A short in-flight socket read may return some of its credit.
                    if str(error) != "network_bytes" or not self.active_reads:
                        raise
                    self.changed.wait(timeout=0.5)
            granted = min(maximum, self.byte_credit)
            self.byte_credit -= granted
            self.active_reads += 1
        unused = 0
        try:
            data = response.read1(granted)
            unused = granted - len(data)
            return data
        finally:
            # After a read exception the bytes consumed are unknown; retain the debit.
            with self.changed:
                self.byte_credit += unused
                self.active_reads -= 1
                self.changed.notify_all()


current: ContextVar[RunBudget | None] = ContextVar("collector_budget", default=None)
