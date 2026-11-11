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


def anchor_labels(data: bytes, base_url: str) -> dict[str, str]:
    """Resolve anchor targets and their first nonempty labels from the captured HTML."""
    parser = Links(base_url, all_links=True)
    parser.feed(data.decode("utf-8", errors="replace"))
    parser.close()
    return {url: next((s for s in labels if s), "") for url, labels in parser.links.items()}


if __name__ == "__main__":
    data = sys.stdin.buffer.read()
    if sys.argv[1] == "--identity":
        from evidence_workers import explicit_identity
        print(json.dumps(explicit_identity(extract_bytes(data, sys.argv[2]), sys.argv[3])))
        sys.exit(0)
    if sys.argv[1] == "--anchors":
        print(json.dumps(list(anchor_labels(data, sys.argv[2]).items())))
        sys.exit(0)
    result = segments(data, sys.argv[1])
    if sys.argv[1] == ".html" and len(sys.argv) == 3:
        result.update({"link " + url: label for url, label in anchor_labels(data, sys.argv[2]).items()})
    print(json.dumps(result))
