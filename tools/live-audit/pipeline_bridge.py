"""Bounded worker bridge to the existing collector and extractor. No model calls."""
import argparse
import hashlib
import json
from pathlib import Path
from documents import collect, LIMIT, Links
from extraction import extract_collection, extract_bytes


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open('xb') as stream:
            stream.write(data)
    except FileExistsError:
        if path.read_bytes() != data:
            raise ValueError('immutable_artifact_collision')


def run(root, request):
    root = root.resolve()
    if request['mode'] == 'live':
        result = collect(request['hospital_key'], Path(__file__).resolve().parents[2], root, save)
        if result['output']['status'] == 'failed':
            raise ValueError('landing_collection_failed')
        extracted = extract_collection(request['hospital_key'], Path(result['manifest_file']).stem, root, save)
        return dict(collection=result['output'], extraction_manifest=str(Path(extracted['manifest_file']).relative_to(root)))
    sources = {}
    for source in request['sources']:
        snapshot = source.get('snapshot')
        if not snapshot:
            continue
        path = (root / snapshot['artifact_path']).resolve()
        if not path.is_relative_to(root) or path.stat().st_size > LIMIT:
            raise ValueError('invalid_snapshot_path_or_size')
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != snapshot['sha256']:
            raise ValueError('snapshot_hash_mismatch')
        segments = extract_bytes(raw, path.suffix)
        if path.suffix == '.html':
            parser = Links(source['source_id'])
            parser.feed(raw.decode('utf-8', errors='replace'))
            segments += [dict(locator='link ' + url, text=next((label for label in labels if label), ''), status='extracted')
                         for url, labels in parser.links.items()]
        sources[source['source_id']] = segments
    return sources


if __name__ == '__main__':
    import sys
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    # Internal IPC output, not application logging. The Node worker logs metadata only.
    print(json.dumps(run(args.root, json.load(sys.stdin)), ensure_ascii=True))
