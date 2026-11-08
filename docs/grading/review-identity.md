# Current reviews and immutable evidence

A document version has a SHA-256 of its saved bytes. A review decision binds the SHA-256 of the entire result file and its measure ID. A logical review can have many such result files. The inbox preserves the original item ID calculation so bookmarks and existing decision files still resolve.

A logical review key hashes an ordered JSON tuple of hospital roster key, review namespace, scope, producer rubric, guideline year, reference version and a sorted set of document tuples. Each document tuple contains the canonical source URL, role and language tag. Application reviews select the hospital application. Official templates and derived renders remain citations. A posted-material review selects its full set of hospital sources. Changing the set creates a separately scoped review. A review run ID and a result timestamp identify individual runs and revisions.

| Change | Current-item behavior |
| --- | --- |
| Same URL, role, language and scope, with new bytes | The new result becomes current in that group. Earlier bytes, findings and decisions stay addressable. |
| Same bytes assessed again | The new immutable result has its own human-decision history, including when only the review interpretation changed. |
| URL moved, query changed, or document replaced at a new URL | Starts a separate logical source, even for identical bytes. Publish a new review at the new URL. This version has no implicit alias migration. |
| A publisher reuses a URL | A replacement in the same role, language and scope is a revision of that publication slot. If the new role or language differs, the keys differ. Simultaneous conflicting versions in one inventory need disambiguation. |
| Duplicate links or a fragment such as `#page=2` | Standard HTTP URL canonicalization and fragment removal produce the same key. Paths and query parameters remain significant. A matching filename or byte hash at another URL establishes no logical relationship. |
| New language, role, rubric, guideline year, hospital or review namespace | Separate current review. `und` marks unknown language. Distinct unknown-language URLs remain distinct. |
| Several results have the same check time | Use the result ID, then the result hash, as deterministic tie-breakers. |

The Python writers attach [v1 identity declarations](../../schemas/review-identity-v1.schema.json). Discovery cross-checks each declared primary URL, role, language and digest against the snapshot and coverage records. A malformed declaration increments the unavailable count. For the pinned Wave 1 inventory, non-English labels come from an exact hospital, role and content hash match. The supported English profile also supplies a language label. A label records inventory metadata. Translation review has its own status.

## Existing records

Discovery derives a legacy key only from a uniquely attributable covered document or source set and a known rubric. When the original rubric is absent, attributable revisions are grouped only within the same native review run and labelled `legacy_unversioned_run`. A historical record with ambiguous scope stays individually visible as `ambiguous_legacy`, keyed by its exact result hash. There is no backfill or rewrite. Exact hashes detect changes and mismatched decisions. The administrative trust boundary is the local evidence store and its writers.

`GET /api/reviews` lists current items. Optional filters are `hospital_key`, `namespace`, `role`, `language` and `source_id`. Detail includes per-document name, role, language, URL, snapshot hash, revision count and version links. For a superseded item, the same detail and source endpoints continue to work. A decision POST on that item is rejected. Decision sequence claims use an atomic filesystem link in the local decisions directory. Existing append-only UUID files remain readable. Confirming an unclear finding records that uncertainty. The source endpoint rehashes the saved bytes and serves HTML as inert text.
