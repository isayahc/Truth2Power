import { confirmedDocuments } from "../grading/data.js";

/** Run independent, read-only specialists against the same immutable source inventory. */
export async function reviewCapturedSources(sources, documents, extract) {
  const inventoryByUrl = new Map(documents.map(d => [d.source_id, d]));
  const pages = [];
  const files = [];
  for (const source of sources) {
    if (!source.snapshot) continue;
    if (source.snapshot.artifact_path.endsWith(".html")) {
      pages.push(source);
      continue;
    }
    const scope = inventoryByUrl.get(source.source_id).campus_applicability;
    const known = confirmedDocuments.some(d => d.sha256 === source.snapshot.sha256);
    files.push({ ...source, allow_explicit_identity: !!source.snapshot.published_link && scope === "unknown" && !known });
  }
  const review = (sources) => sources.length
    ? extract(sources)
    : { sources: {}, reviews: {}, application_reviews: [], file_text_status: {} };
  // Both workers read immutable captures. Settle both before closing the run's usage ledger.
  const workers = await Promise.allSettled([review(pages), review(files)]);
  for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
  const [website, documentsReview] = workers.map(worker => worker.value);
  return { sources: { ...website.sources, ...documentsReview.sources },
    reviews: { ...website.reviews, ...documentsReview.reviews }, application_reviews: documentsReview.application_reviews,
    file_text_status: documentsReview.file_text_status };
}

/** Connect the collector's candidate dispositions to anchors in the saved original HTML. */
export function attachWebsiteLinks(analysis, collection) {
  if (!collection) return;
  const outcomes = new Map([...(collection.pages ?? []), ...(collection.documents ?? [])].map(d => [d.source_url, d]));
  const anchors = new Map();
  for (const [url, review] of Object.entries(analysis.reviews)) {
    if (review.worker !== "website_reviewer") continue;
    review.links = [];
    anchors.set(url, new Map(analysis.sources[url].filter(s => s.locator.startsWith("link "))
      .map(s => [s.locator.slice(5), s.text])));
  }
  for (const link of collection.links ?? []) {
    if (link.disposition !== "candidate") continue;
    const page = analysis.reviews[link.parent_url];
    if (!page || page.sha256 !== link.parent_sha256 || anchors.get(link.parent_url)?.get(link.target_url) !== link.anchor_label) continue;
    const attempt = outcomes.get(link.target_url);
    page.links.push({ target_url: link.target_url, anchor_label: link.anchor_label,
      status: attempt?.status ?? "not_attempted", reason: attempt?.error_code ?? attempt?.reason ?? null,
      http_status: attempt?.http_status ?? null, sha256: attempt?.sha256 ?? null });
  }
}
