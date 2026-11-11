/** Unclassified child HTML may supply a transport edge, never a classified document. */
export const isPostingPage = (source) => source.role === "landing_page" ||
  (source.role === "unclassified" && source.snapshot?.artifact_path.endsWith(".html"));

/** Construct paths from already extracted ORIGINAL HTML. No URL is fetched here. */
export function postingPaths(sources, extracted, start, roles, confirmed, hospital, maxDepth = 8) {
  const queue = [{ url: start, path: [] }], seen = new Set(), found = [];
  const hosts = new Set([start, sources.find(s => s.source_id === start)?.snapshot?.final_url]
    .filter(Boolean).map(url => new URL(url).hostname.replace(/^www\./, "")));
  while (queue.length) {
    const { url, path } = queue.shift();
    if (seen.has(url) || path.length >= Math.min(maxDepth, 8)) continue;
    seen.add(url);
    const page = sources.find((s) => s.source_id === url && isPostingPage(s) && s.snapshot && !["unavailable", "unreadable"].includes(s.status));
    if (!page) continue;
    for (const anchor of extracted[url] || []) {
      if (!anchor.locator.startsWith("link ") || anchor.status !== "extracted") continue;
      const target = anchor.locator.slice(5);
      let parsed;
      try { parsed = new URL(target); } catch { continue; }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) continue;
      const edge = { source_id: url, snapshot_id: page.snapshot.snapshot_id, sha256: page.snapshot.sha256, locator: anchor.locator, quote: anchor.text };
      const chain = [...path, edge];
      const doc = sources.find((s) => s.source_id === target && s.snapshot && !["unavailable", "unreadable"].includes(s.status));
      if (!doc) continue;
      const onHost = hosts.has(parsed.hostname.replace(/^www\./, ""));
      if (!onHost && (isPostingPage(doc) || doc.snapshot.published_link?.parent_url !== url ||
          doc.snapshot.published_link.parent_sha256 !== page.snapshot.sha256)) continue;
      if (isPostingPage(doc) && !hosts.has(new URL(doc.snapshot.final_url || target).hostname.replace(/^www\./, ""))) continue;
      if (isPostingPage(doc)) { queue.push({ url: target, path: chain }); continue; }
      const known = confirmed.find((d) => d.hospital_key === hospital && (!d.source_id || d.source_id === target) && d.sha256 === doc.snapshot.sha256 && d.role === doc.role && roles.includes(d.role));
      if (!known) continue;
      const citations = [{ locator: known.locator, quote: known.quote }, ...(known.applicability ? [known.applicability] : [])];
      if (!citations.every((c) => extracted[target]?.some((p) => p.status === "extracted" && p.locator === c.locator && p.text.includes(c.quote)))) continue;
      found.push({ target, evidence: [...chain, ...citations.map((c) => ({ source_id: target, snapshot_id: doc.snapshot.snapshot_id,
        sha256: doc.snapshot.sha256, locator: c.locator, quote: c.quote }))] });
    }
  }
  return found;
}
