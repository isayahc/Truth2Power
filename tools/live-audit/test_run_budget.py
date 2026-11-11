"""Offline boundary tests for live collector quotas across attempt leases."""
import io
import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
import tempfile
import time
import unittest
from email.message import Message
from pathlib import Path
from unittest.mock import MagicMock, patch

from documents import collect, download
from pipeline_bridge import save
from run_budget import BudgetStop, RunBudget, current


class CollectorBudgetTests(unittest.TestCase):
    def setUp(self) -> None:
        """Create a synthetic job database and install a fenced collector context."""
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        database = str(self.root / "test.sqlite")
        self.db = sqlite3.connect(database)
        self.addCleanup(self.db.close)
        self.db.executescript("""
          CREATE TABLE jobs(id,token,status);
          INSERT INTO jobs VALUES(1,'first','running');
          CREATE TABLE audit_quota(job,unit,used,PRIMARY KEY(job,unit));""")
        self.spec = dict(database=database, job=1, token="first", deadline=time.time()*1000+60000,
                         limits=dict(network_requests=2, network_bytes=6, pages=1, documents=1))
        self.budget = RunBudget(self.spec)
        self.addCleanup(self.budget.db.close)
        self.addCleanup(current.reset, current.set(self.budget))

    def test_read_boundary_and_reclaimed_worker(self) -> None:
        """A seven-byte body cannot consume more than six, even after retry."""
        response = MagicMock(status=200)
        response.headers = Message()
        stream = io.BytesIO(b"1234567")
        response.read1.side_effect = stream.read1
        connection = MagicMock()
        connection.getresponse.return_value = response
        with patch("documents.public_addresses", return_value=["8.8.8.8"]), patch("documents.socket.create_connection"), \
                patch("documents.ssl.create_default_context"), patch("documents.http.client.HTTPSConnection", return_value=connection):
            with self.assertRaisesRegex(BudgetStop, "network_bytes"):
                download("https://example.org/data","example.org")
            self.assertEqual(stream.tell(),6)
            with self.db:
                self.db.execute("UPDATE jobs SET token='second'")
            with self.assertRaisesRegex(BudgetStop,"inactive_attempt"):
                self.budget.reserve("network_requests")
            self.spec["token"]="second"
            with self.assertRaisesRegex(BudgetStop,"network_bytes"):
                download("https://example.org/data","example.org")
            self.assertEqual(connection.request.call_count,1)
            self.assertEqual(self.budget.reserve("network_requests"),1)
            with self.assertRaisesRegex(BudgetStop,"network_requests"):
                self.budget.reserve("network_requests")
            with self.db:
                self.db.execute("UPDATE jobs SET status='cancelled'")
            with self.assertRaisesRegex(BudgetStop,"inactive_attempt"):
                self.budget.reserve("pages")

    def test_short_reads_share_prepaid_bytes_and_check_the_worker_lease(self) -> None:
        """Hundreds of short reads need three reservations for a roughly 3 MiB response."""
        size = 3 * 1024 * 1024 - 11
        self.spec['limits']['network_bytes'] = size + 1024 * 1024
        stream = io.BytesIO(b'x' * size)
        response = MagicMock()
        response.read1.side_effect = lambda maximum: stream.read1(min(maximum, 16 * 1024))
        writes = []
        self.budget.db.set_trace_callback(lambda sql: writes.append(sql) if sql.startswith('INSERT INTO audit_quota') else None)
        with self.budget.downloader():
            while stream.tell() < size:
                self.budget.read(response, 64 * 1024)
            with self.db:
                self.db.execute("UPDATE jobs SET token='replacement'")
            with self.assertRaisesRegex(BudgetStop, "inactive_attempt"):
                self.budget.read(response, 64 * 1024)
        self.assertEqual(len(writes), 3)
        self.assertEqual(self.db.execute("SELECT used FROM audit_quota WHERE unit='network_bytes'").fetchone()[0], size)

    def test_concurrent_downloaders_never_spend_over_the_same_byte_budget(self) -> None:
        """Short reads racing at the quota boundary consume exactly the shared allowance."""
        self.spec['limits']['network_bytes'] = 90_000
        streams = [io.BytesIO(b'x' * 60_000) for _ in range(2)]
        start = threading.Barrier(2)

        def transfer(stream: io.BytesIO) -> None:
            """Spend under one lease, forcing concurrent consumption with short reads."""
            with self.budget.downloader():
                start.wait(timeout=3)
                while stream.tell() < 60_000:
                    try:
                        self.budget.read(stream, 2048)
                    except BudgetStop as error:
                        self.assertEqual(str(error), 'network_bytes')
                        break

        with ThreadPoolExecutor(2) as workers:
            list(workers.map(transfer, streams))
        used = self.db.execute("SELECT used FROM audit_quota WHERE unit='network_bytes'").fetchone()[0]
        self.assertEqual(used, 90_000)
        self.assertEqual(sum(s.tell() for s in streams), used)

    def test_partial_manifest_keeps_first_page(self) -> None:
        """Exhausting the page quota preserves the first captured original."""
        (self.root/"data/maps").mkdir(parents=True)
        (self.root/"data/maps/hospitals.geojson").write_text(json.dumps({"features":[
            {"id":"739","properties":{"assistance_url":"https://example.org/aid"}}]}))
        def fetch(url: str, host: str) -> tuple[bytes,str,str]:
            """Return the saved landing fixture without network access."""
            return b'<a href="/resources">SYN resources</a>', url, "text/html"
        result=collect("739",self.root,self.root,save,fetch=fetch)
        manifest=json.loads(Path(result["manifest_file"]).read_bytes())
        self.assertEqual(manifest["status"],"partial")
        self.assertEqual(manifest["budget_stop"],"pages")
        self.assertTrue((self.root/manifest["landing_page"]["artifact_path"]).is_file())
