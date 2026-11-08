"""Read-only verification of #16/#18's pinned public-document evidence inventory.

Requires the local .audit/live snapshots; no network calls or model invocations.
Prints metadata only. Source excerpts remain in the checked-in inventory.
"""
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit

from cross_documents import load_sources


def verify(root):
    data = root / '.audit/live'
    inventory = json.loads((root / 'docs/audit-format/wave-one-document-inventory.json').read_text(encoding='utf-8'))
    summary = []
    for hospital in inventory['hospitals']:
        key = hospital['hospital_key']
        manifest = data / 'collections' / key / (hospital['collection_id'] + '.json')
        collection = json.loads(manifest.read_text(encoding='utf-8'))
        extraction = json.loads((data / 'extractions' / key / hospital['extraction_id'] / 'manifest.json').read_text(encoding='utf-8'))
        assert extraction['collection_manifest'] == manifest.relative_to(data).as_posix()
        assert collection['hospital_key'] == key
        landing = collection['landing_page']
        assert landing['sha256'] == hospital['landing_sha256']
        assert landing['artifact_path'] == f"snapshots/{landing['sha256']}.html"
        assert hashlib.sha256((data / landing['artifact_path']).read_bytes()).hexdigest() == landing['sha256']
        assert collection['attempted_at'] <= landing['retrieved_at'] <= collection['completed_at']
        assert 'publisher_updated_at' in landing  # Unknown stays separate from retrieval time.
        sources, gaps = load_sources(key, hospital['extraction_id'], data)
        docs = collection['documents']
        assert len(docs) == len(hospital['documents'])
        filenames = [Path(urlsplit(d['source_url']).path).name for d in docs]
        assert len(set(filenames)) == len(filenames)
        assert set(filenames) == {d['filename'] for d in hospital['documents']}
        confirmed, flagged = 0, 0
        for entry in hospital['documents']:
            record = docs[filenames.index(entry['filename'])]
            if entry['status'] == 'unavailable_type_unconfirmed':
                assert record['status'] == 'failed' and record['http_status'] == entry['http_status']
                assert any(g['url'] == record['source_url'] for g in gaps)
                flagged += 1
                continue
            assert record['status'] == 'saved' and record['sha256'] == entry['sha256']
            source = next(s for s in sources if s['snapshot']['url'] == record['url'])
            assert source['snapshot']['sha256'] == entry['sha256']
            # Verify actual evaluator routing, not only the documentary label.
            assert source['snapshot']['document_type'] == entry['type']
            assert any(p['locator'] == entry['locator'] and entry['quote'] in p['text'] for p in source['segments'])
            confirmed += entry['status'] == 'content_confirmed'
            flagged += entry['status'] != 'content_confirmed'
        summary.append(dict(hospital_key=key, landing_hash_verified=True,
                            landing_retrieved_at=landing['retrieved_at'], documents=len(docs),
                            content_confirmed=confirmed, flagged=flagged))
    return summary


if __name__ == '__main__':
    print(json.dumps(verify(Path(__file__).resolve().parents[2]), indent=2))
