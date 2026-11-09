"""Expose the existing immutable PDF/DOCX/HTML segment extractor to the Node grader."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools/live-audit"))
from extraction import extract_bytes


def segments(data: bytes, suffix: str) -> dict[str, str | None]:
    """Keep failed segments visible so a partial source cannot certify complete coverage."""
    return {s["locator"]: s["text"] if s["status"] == "extracted" else None for s in extract_bytes(data, suffix)}


if __name__ == "__main__":
    print(json.dumps(segments(sys.stdin.buffer.read(), sys.argv[1])))
