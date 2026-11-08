"""Validate the synthetic live audit contract examples and evidence references."""
import hashlib
import json
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

folder = Path(__file__).resolve().parent
schema = json.loads((folder.parents[1] / "schemas/live-audit-v1.schema.json").read_text(encoding="utf-8"))
Draft202012Validator.check_schema(schema)
validator = Draft202012Validator(schema, format_checker=FormatChecker())
examples = folder / "examples"
complete, failed = [json.loads((examples / name).read_text(encoding="utf-8"))
                    for name in ("completed.json", "failed-recheck.json")]


def check(example, previous_success=None):
    """Fixture-level relational checks, not a production ingestion adapter."""
    errors = [error.message for error in validator.iter_errors(example)]
    if errors:
        return errors
    snapshots = {item["snapshot_id"]: item for item in example["snapshots"]}
    if len(snapshots) != len(example["snapshots"]):
        errors.append("duplicate snapshot ID")
    assessment = example["assessment"]
    expected_success = assessment["completed_at"] if assessment else previous_success
    if example["last_successful_assessment_at"] != expected_success:
        errors.append("last-success timestamp changed incorrectly")
    if not assessment:
        return errors
    findings = assessment["findings"]
    if len({f["measure_id"] for f in findings}) != len(findings):
        errors.append("duplicate measure ID")
    for finding in findings:
        for citation in finding["evidence"]:
            snapshot = snapshots.get(citation["snapshot_id"])
            if snapshot is None:
                errors.append("unresolved snapshot reference")
                continue
            path = (examples / snapshot["artifact_path"]).resolve()
            if not path.is_relative_to(examples.resolve()):
                errors.append("fixture path outside examples")
                continue
            raw = path.read_bytes()
            if hashlib.sha256(raw).hexdigest() != snapshot["sha256"]:
                errors.append("snapshot hash mismatch")
            # This deliberately supports only the synthetic fixture's known locator.
            if citation["locator"] != "line 2" or citation["quote"] != raw.decode("utf-8").splitlines()[1]:
                errors.append("quote or locator mismatch")
    return errors


assert not check(complete)
assert not check(failed, complete["last_successful_assessment_at"])
assert not check(failed | {"last_successful_assessment_at": None})  # First attempt fails.
findings = complete["assessment"]["findings"]
assert {item["result"] for item in findings} == {"yes", "no", "unclear", "n_a"}
assert complete["guideline_year"] == 2026
assert findings[0]["observed"]["amount"] != findings[0]["expected"]["amount"]
assert complete["snapshots"][0]["publisher_updated_at"] is None

invalid_cases = [
    ("failed attempt with assessment", failed | {"assessment": complete["assessment"]}),
    ("completed attempt without assessment", complete | {"assessment": None}),
    ("failure advances last success", failed | {"last_successful_assessment_at": failed["attempt"]["attempted_at"]}),
    ("completion has wrong last success", complete | {"last_successful_assessment_at": "2026-01-01T00:00:00Z"}),
]


def changed(label, mutate):
    example = deepcopy(complete)
    mutate(example)
    invalid_cases.append((label, example))


changed("missing adverse evidence", lambda x: x["assessment"]["findings"][0].update(evidence=[]))
changed("duplicate measure", lambda x: x["assessment"]["findings"].append(deepcopy(x["assessment"]["findings"][0])))
changed("duplicate snapshot", lambda x: x["snapshots"].append(deepcopy(x["snapshots"][0])))
changed("unresolved citation", lambda x: x["assessment"]["findings"][0]["evidence"][0].update(snapshot_id="SYN-missing"))
changed("invented quote", lambda x: x["assessment"]["findings"][0]["evidence"][0].update(quote="SYN invented text"))
changed("wrong hash", lambda x: x["snapshots"][0].update(sha256="0" * 64))
changed("invalid publisher date", lambda x: x["snapshots"][0].update(publisher_updated_at="yesterday"))
changed("N/A without exemption", lambda x: x["assessment"]["findings"][3].update(reason_code="insufficient_evidence"))
changed("absence without search notes", lambda x: x["assessment"]["findings"][0].update(reason_code="missing_after_search"))
changed("unsupported approval property", lambda x: x.update(human_approved=True))
for label, invalid in invalid_cases:
    assert check(invalid, complete["last_successful_assessment_at"]), f"Accepted invalid case: {label}"
print(f"Output contract: 3 valid scenarios and {len(invalid_cases)} rejection scenarios passed.")
