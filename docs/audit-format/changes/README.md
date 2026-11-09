# Recent changes and discovery evidence

Open `/?view=changes` or read `GET /api/changes`. The default demo includes a real audit discovery for Little Falls. Both the dashboard and hospital page read the newer S posting assessment. Historic source artifacts and the pinned #38 comparison remain individually reproducible.

| Evidence | Observation |
| --- | --- |
| [Earlier direct-link assessment](../posting/362.json) | S was unclear. The roster page directly linked a network resource guide, whose designation was uncertain. |
| [Child-page capture and summary review](../summaries/README.md) | The saved roster HTML links to a designated summary page. That page links to English and Spanish PDFs whose titles and campus passages establish their applicability to Little Falls. |
| [Posting reassessment](362-summary-posting.json) | The new S-only v1 draft records Yes, retaining all four source hashes and citations. Its completion timestamp is the feed’s audit detection time. The hospital publication date is unknown. |

The wider discovery scope explains the finding change. The parent HTML hash is identical to the earlier posting capture. The feed displays this as an audit discovery. The new result participates in the hospital-page posting history and does not authorize an institutional grade.

## Saved fetch comparison

The service reads the collector's `collections/<hospital_key>/*.json` and `snapshots/` directories under `T2P_REVIEW_DIRECTORY` (default `.audit/live`). It compares consecutive successfully saved observations of the same hospital and original source URL, ordered by retrieval time. A first observation establishes a baseline. Failed requests supply no evidence of removal. A successfully captured landing page can establish that a link disappeared from that particular page.

- For landing HTML, the comparison checks direct PDF/DOCX targets, financial-assistance page URLs, and visible lines containing assistance-related terms. For PDF/DOCX, it compares normalized, located text extracted by the existing parser.
- Identical hashes, whitespace-only changes, or different bytes with identical compared content generate no material event. The comparison has limited text coverage and cannot certify unchanged visual content, image-only tables, translations or the entire site.
- For a changed pair, both source blobs must match their saved SHA-256. Incomplete extraction, corrupt/missing originals and conflicting observations at the same instant are flagged. The feed links the hospital and applicable follow-up checks. A text change triggers review, not a compliance finding.
- Events retain both source URLs, hashes, locators, excerpts and retrieval dates. Publisher dates come only from the source records. Local originals can be downloaded as inert, hash-checked attachments. When they are unavailable the feed still shows the pinned discovery citations. Publisher links open the current website.

## Reproduction

The feed and reassessment work offline. With the #21 posting snapshots and #24 summary capture originals under the same evidence root, reproduce the new draft byte for byte:

```bash
saved=docs/audit-format/changes/362-summary-posting.json
stamp=$(python -c 'import json,sys;print(json.load(open(sys.argv[1]))["assessment"]["completed_at"])' "$saved")
python tools/live-audit/verify_summary_posting.py --root .audit/live --assessed-at "$stamp" > /tmp/posting-replay.json
cmp "$saved" /tmp/posting-replay.json
python tools/live-audit/changes.py --root .audit/live
python -m unittest discover -s tools/live-audit -p 'test_changes.py'
npm run build && node scripts/test-changes-e2e.js
```

Use the existing live-audit Python dependencies, `T2P_PYTHON` to select an interpreter for the server, and `CHROMIUM_PATH` to select an installed browser. The browser regression creates two synthetic saved fetches plus an identical retry in a temporary directory and exercises the real discovery on the same feed.
