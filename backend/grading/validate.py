"""Validate one grading input against the local schema registry without URL retrieval."""
import json
import sys
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[2]
BASE = "https://truth2power.local/schemas/"


def validate(document: dict, name: str) -> None:
    """Load the rubric and v1 contract siblings and enforce date/URI formats offline."""
    resources = {}
    for path in (ROOT / "schemas").glob("*.schema.json"):
        schema = json.loads(path.read_bytes())
        schema.setdefault("$id", BASE + path.name)
        resources[path.name] = schema
    registry = Registry().with_resources((s["$id"], Resource.from_contents(s)) for s in resources.values())
    validator = Draft202012Validator(resources[name], registry=registry, format_checker=FormatChecker())
    error = next(validator.iter_errors(document), None)
    if error:
        raise ValueError(f"{error.json_path}: invalid {error.validator}")


if __name__ == "__main__":
    try:
        validate(json.load(sys.stdin), sys.argv[1])
    except ValueError as error:
        sys.exit(str(error))
