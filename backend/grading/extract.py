"""Expose the existing immutable PDF/DOCX/HTML segment extractor to the Node grader."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools/live-audit"))
from extraction import extract_bytes
from documents import Links


def segments(data: bytes, suffix: str) -> dict[str, str | None]:
    """Keep failed segments visible so a partial source cannot certify complete coverage."""
    return {s["locator"]: s["text"] if s["status"] == "extracted" else None for s in extract_bytes(data, suffix)}


if __name__ == "__main__":
    data = sys.stdin.buffer.read()
    result = segments(data, sys.argv[1])
    if sys.argv[1] == ".html" and len(sys.argv) == 3:
        parser = Links(sys.argv[2])
        parser.feed(data.decode("utf-8", errors="replace"))
        parser.close()
        result.update({"link " + url: next((label for label in labels if label), "") for url, labels in parser.links.items()})
    print(json.dumps(result))
