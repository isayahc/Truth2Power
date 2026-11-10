"""Benchmark offline replay in an isolated Linux/WSL store and rehearse cold recovery."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from typing import Any
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CLI = ["node", "backend/audit/pipeline-cli.js"]
SITES = ("2", "1", "362", "1002")


def digest(path: Path) -> str:
    """Hash one persisted artifact for the cold-backup comparison."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inventory(root: Path) -> dict[str, str]:
    """Map retained relative file paths to byte identities, including the SQLite database."""
    return {str(p.relative_to(root)): digest(p) for p in root.rglob("*") if p.is_file()}


def size(root: Path) -> int:
    """Count logical bytes in the whole audit store."""
    return sum(p.stat().st_size for p in root.rglob("*") if p.is_file())


def cli(env: dict[str, str], *args: str) -> dict[str, Any]:
    """Read a single JSON object from a fresh operator CLI process."""
    return json.loads(subprocess.check_output([*CLI, *args], cwd=ROOT, env=env))


def replay(env: dict[str, str], evidence: Path, site: str, cycle: int) -> dict[str, Any]:
    """Measure one CLI execution and reconcile its ledger after the worker exits."""
    store = Path(env["AUDIT_DIR"])
    before = size(store)
    start = time.monotonic()
    with tempfile.TemporaryFile() as output:
        command = [*CLI, "run", "--hospital", site, "--mode", "replay", "--date", "2026-11-09",
                   "--request", f"handoff-{site}-{cycle}", "--evidence-root", str(evidence)]
        with subprocess.Popen(command, cwd=ROOT, env=env, stdout=output) as proc:
            _, status, usage = os.wait4(proc.pid, 0)
            proc.returncode = os.waitstatus_to_exitcode(status)
            if proc.returncode:
                raise RuntimeError(f"Replay failed for {site}")
        elapsed = time.monotonic() - start
        output.seek(0)
        job, result = [json.loads(line) for line in output]
    receipt = cli(env, "receipt", "--job", str(job["job_id"]))
    bundle = json.loads((Path(env["T2P_REVIEW_DIRECTORY"]) / result["path"]).read_bytes())
    history = cli(env, "history", "--hospital", site)
    assert history["last_successful_source_retrieval"] is None and history["next_due_at"] is None
    assert history["last_eligible_assessment"] is None and history["last_completed_execution"]["audit_run_id"] == receipt["audit_run_id"]
    assert len(bundle["report"]["findings"]) == 17 and bundle["report"]["final_grade"] is None
    if site == "1":
        assert any(s["campus_applicability"] == "other_campus_requires_review" and s["role"] == "unclassified"
                   for s in bundle["inventory"]["sources"])
    if site == "2":
        assert any("404" in gap for gap in bundle["inventory"]["gaps"])
    assert result["unresolved"] == (17 if site in ("1", "2") else 14)
    assert receipt["zero_incremental_api"] and receipt["units"]["network_requests"] == 0
    assert receipt["units"]["paid_model_calls"] == 0 and receipt["known_billed_usd"] == 0
    assert len(receipt["attempts"]) == 1 and result["revision"] == bundle["id"]
    units = receipt["units"]
    card = receipt["rate_card"]
    local = sum(units.get(unit, 0) * rate for unit, rate in card["local"].items())
    assert abs(receipt["estimated_local_compute_storage_network"] - local) < 1e-9
    return dict(site=site, cycle=cycle, job=job["job_id"], revision=result["revision"], unresolved=result["unresolved"],
                wall_seconds=round(elapsed, 4), cpu_seconds=round(usage.ru_utime + usage.ru_stime, 4),
                max_rss_kib=usage.ru_maxrss, store_growth_bytes=size(store)-before, units=units, local_scenario_usd=local)


def verify(base: Path) -> dict[str, Any]:
    """Seed four campuses, run comparable jobs, and restore the complete stopped store."""
    store, evidence = base/"audit", base/"input"
    store.mkdir()
    evidence.mkdir()
    for name in ("pilot-wave-one-evidence.zip", "application-reference-evidence.zip"):
        with zipfile.ZipFile(ROOT/"docs/validation"/name) as archive:
            archive.extractall(evidence)
    for site in SITES[:2]:
        subprocess.run([sys.executable, "backend/test/fixtures/roster-collector.py", str(evidence)], cwd=ROOT,
                       input=json.dumps(dict(hospital_key=site, bounds={})), text=True, stdout=subprocess.DEVNULL, check=True)
    card = dict(version="handoff-illustrative-v1", effective_date="2026-11-09", currency="USD",
                local=dict(elapsed_ms=1 / 3600000, storage_bytes=0.02 / 1000000000, network_bytes=0), models={})
    rate_path = base/"rates.json"
    rate_path.write_text(json.dumps(card))
    env = {k: v for k, v in os.environ.items() if not k.startswith("T2P_")}
    env.update(AUDIT_DIR=str(store), T2P_REVIEW_DIRECTORY=str(store/"live"), T2P_RATE_CARD=str(rate_path),
               T2P_PYTHON=sys.executable)
    rows = [replay(env, evidence, site, cycle) for cycle in (1, 2) for site in SITES]
    last = rows[-1]
    # Create the decision through the same review service used by the inbox.
    decision = subprocess.check_output(["node", "--input-type=module", "-e", """
import {createReviewService} from './backend/review/service.js';
const svc=createReviewService(process.env.T2P_REVIEW_DIRECTORY);
const item=svc.list({hospital_key:'1002'}).items[0];
console.log(JSON.stringify(svc.decide(item.id,{action:'request_information',revision:0,
  reviewer_role:'SYN handoff exercise',notes:'SYN verify recovery'})));
"""], env=env, cwd=ROOT)
    prior = cli(env,"receipt","--job",str(last["job"]))
    backup = base/"backup"
    shutil.copytree(store, backup)
    expected = inventory(backup)
    # Concurrent clients resend one intent after the backup. Rollback must remove it.
    def duplicate(_: int) -> int:
        """Queue one identical request from an independent process."""
        return cli(env, "queue", "--hospital", "1", "--mode", "replay", "--request", "handoff-duplicate")["job_id"]
    with ThreadPoolExecutor(max_workers=4) as clients:
        ids = list(clients.map(duplicate, range(4)))
    assert len(set(ids)) == 1
    store.rename(base/"before-restore")
    shutil.copytree(backup,store)
    assert inventory(store) == expected
    with sqlite3.connect(store/"audit.sqlite") as db:
        assert db.execute("SELECT count(*) FROM jobs WHERE id=?", (ids[0],)).fetchone() == (0,)
        assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    assert cli(env,"receipt","--job",str(last["job"])) == prior
    restored = cli(env,"replay",str(store/"live/pipeline-assessments"/(last["revision"]+".json")))
    assert restored["replay"] == "identical"
    decision_id=json.loads(decision)["id"]
    detail=subprocess.check_output(["node","--input-type=module","-e","""
import {createReviewService} from './backend/review/service.js';
console.log(JSON.stringify(createReviewService(process.env.T2P_REVIEW_DIRECTORY).detail(process.argv[1]).history));
""",decision_id],env=env,cwd=ROOT)
    assert json.loads(detail)[0]["notes"]=="SYN verify recovery"
    return dict(schema_version=1, platform=platform.system(), node=subprocess.check_output(["node","-v"],text=True).strip(),
                python=platform.python_version(), rate_card=card, samples=rows, restore="passed",
                monthly_scenario_usd=[212*f(row["local_scenario_usd"] for row in rows) for f in (min,max)])


if __name__ == "__main__":
    if sys.platform != "linux":
        raise SystemExit("Run on Linux or WSL for comparable wait4 memory units.")
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", type=Path, help="Retain the demo and backup in a NEW isolated directory")
    args = parser.parse_args()
    if args.keep:
        args.keep.mkdir(parents=True, exist_ok=False)
        print(json.dumps(verify(args.keep.resolve()), indent=2))
    else:
        with tempfile.TemporaryDirectory(prefix="SYN-handoff-") as folder:
            print(json.dumps(verify(Path(folder)), indent=2))
