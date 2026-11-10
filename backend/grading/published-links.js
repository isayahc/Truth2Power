import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readArtifact, requireValue } from "./data.js";
import { sha256, sourceUrl } from "../review/identity.js";

const host = url => new URL(url).hostname.replace(/^www\./, "");

/** Rebuild new discovery edges from original HTML, through to the roster landing page. */
export function verifyPublishedLinks(snapshots, landing, root) {
  const verified = new Map(), anchors = new Map();
  const hosts = new Set([landing, snapshots.get(landing)?.final_url].filter(Boolean).map(host));
  const check = (url, visiting = new Set()) => {
    if (verified.has(url)) return verified.get(url);
    requireValue(!visiting.has(url) && visiting.size < 8, "Invalid published document path");
    visiting.add(url);
    const edge = snapshots.get(url)?.published_link;
    requireValue(edge && typeof edge.anchor_label === "string" && url !== landing && sourceUrl(edge.target_url) === url,
      "Invalid published document path");
    const parentId = sourceUrl(edge.parent_url), parent = snapshots.get(parentId);
    requireValue(parent?.artifact_path === `snapshots/${edge.parent_sha256}.html` &&
      parent.sha256 === edge.parent_sha256 && hosts.has(host(parentId)) && hosts.has(host(parent.final_url || parentId)),
      "Published link requires a captured hospital page");
    const depth = parentId === landing ? 1 : 1 + check(parentId, visiting);
    requireValue(depth <= 8, "Published document path exceeds traversal depth");
    if (!anchors.has(parentId)) {
      const raw = readArtifact(root, parent.artifact_path);
      requireValue(sha256(raw) === parent.sha256, "Published link parent checksum mismatch");
      const parsed = spawnSync(process.env.T2P_PYTHON || "python",
        [fileURLToPath(new URL("extract.py", import.meta.url)), "--anchors", parent.final_url || parentId],
        { input: raw, encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
      requireValue(parsed.status === 0, "Could not verify published links from captured HTML");
      anchors.set(parentId, new Map(JSON.parse(parsed.stdout)));
    }
    requireValue(anchors.get(parentId).get(edge.target_url) === edge.anchor_label,
      "Published link or label missing from captured parent HTML");
    verified.set(url, depth);
    return depth;
  };
  for (const [url, snapshot] of snapshots) if (snapshot?.published_link) check(url);
}
