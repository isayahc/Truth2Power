"""Validate the synthetic live audit contract examples and evidence references."""
import hashlib
import json
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker, ValidationError

folder = Path(__file__).resolve().parent
schema = json.loads((folder.parents[1] / "schemas/live-audit-v1.schema.json").read_text())
Draft202012Validator.check_schema(schema)
validator = Draft202012Validator(schema, format_checker=FormatChecker())
examples = folder / "examples"
complete, failed = [json.loads((examples / name).read_text()) for name in ("completed.json", "failed-recheck.json")]
for example in (complete, failed):
    validator.validate(example)
assessment = complete["assessment"]
assert failed["last_successful_assessment_at"] == complete["last_successful_assessment_at"] == assessment["completed_at"]
snapshots = {item["snapshot_id"]: item for item in complete["snapshots"]}
findings = assessment["findings"]
assert len({item["measure_id"] for item in findings}) == len(findings)
assert {item["result"] for item in findings} == {"yes", "no", "unclear", "n_a"}
for finding in findings:
    for citation in finding["evidence"]:
        snapshot = snapshots[citation["snapshot_id"]]
        raw = (examples / snapshot["artifact_path"]).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == snapshot["sha256"]
        assert raw.decode().splitlines()[1] == citation["quote"] and citation["locator"] == "line 2"
for invalid in (failed | {"assessment": assessment}, complete | {"assessment": None}):
    assert not validator.is_valid(invalid)
findings[0]["evidence"] = []
try:
    validator.validate(complete)
except ValidationError:
    print("Live audit contract examples and evidence checks passed.")
else:
    raise AssertionError("An unsupported adverse finding passed validation")
