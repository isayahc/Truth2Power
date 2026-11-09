# Wave 1 posted-material findings

These six draft findings concern the two roster-linked assistance pages captured November 8, 2026 (New York time). The v1 envelopes record timestamps in UTC. Original captures were unavailable in the implementation checkout, so both sites were collected again. The Little Falls landing hash matched the previous capture. Ellenville's landing HTML changed. The cited document bytes matched the earlier content-confirmed inventory.

| Hospital | R · application | S · plain-language summary | T · policy statement |
| --- | --- | --- | --- |
| [Ellenville, 1002](1002.json) | Yes · five language versions | Yes · English and Spanish | Yes · English and Spanish |
| [Little Falls, 362](362.json) | Yes · English and Spanish | Unclear · designation and campus applicability of the network guide need review | Yes · linked network statement in English and Spanish |

Ellenville's older linked policy returned HTTP 404. Its accessible policy statements independently establish T. Little Falls links to a 15-page Patient Financial Assistance Guide. Its candidate anchor, title citation, hash and open question accompany S. R/S/T concern posting on the roster-linked site. The content of individual applications, translation quality and hospital-wide compliance require separate assessments.

## Offline replay

The two JSON envelopes conform to `schemas/live-audit-v1.schema.json`. Each positive finding cites the anchor's resolved URL and visible label, then the linked source's exact role excerpt at its saved locator. Role classification is pinned by hospital and document SHA-256. Redirects requiring classification, unknown bytes and incomplete searches produce coverage gaps. This bounded direct-link collector can establish presence. It cannot certify absence from an entire hospital website.

Use the two checked-in collection manifests and their matching hash-addressed public source snapshots. The accompanying `Truth2Power-21-evidence.zip` contains the 17 original files under `snapshots/`. Extract it under a local audit directory. With the Python live-audit dependencies installed and the repository as the working directory:

```bash
unzip Truth2Power-21-evidence.zip -d .audit/posting-21
for key in 1002 362; do
  saved="docs/audit-format/posting/$key.json"
  stamp=$(python -c 'import json,sys; print(json.load(open(sys.argv[1]))["assessment"]["completed_at"])' "$saved")
  python tools/live-audit/posting.py "docs/audit-format/posting/collections/$key.json" \
    --root .audit/posting-21 --assessed-at "$stamp" > "/tmp/posting-$key.json" || exit 1
  cmp "$saved" "/tmp/posting-$key.json" || exit 1
  node backend/grading/cli.js adapt "$saved" --root .audit/posting-21 > "/tmp/input-$key.json" || exit 1
  node backend/grading/cli.js grade "/tmp/input-$key.json" --root .audit/posting-21 > "/tmp/grade-$key.json" || exit 1
done
```

For a new assessment, omit `--assessed-at` and save the new output separately. A failed landing capture cannot produce a completed assessment. The grader independently parses saved links, verifies target hashes and role excerpts, and carries unassessed measures forward as unresolved. Both institutional grades are pending. The checked-in manifests record which official URLs were retrieved and when.
