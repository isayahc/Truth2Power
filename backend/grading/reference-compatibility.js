import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { sha256 } from "../review/identity.js";

const bytes = readFileSync(new URL("../../references/hhs-poverty-contiguous-v1.json", import.meta.url));
const current = JSON.parse(bytes);
const lf = bytes.toString("utf8").replaceAll("\r\n", "\n");
const representations = new Map([[sha256(Buffer.from(lf)), "verified_line_endings"],
  [sha256(Buffer.from(lf.replaceAll("\n", "\r\n"))), "verified_line_endings"],
  [sha256(bytes), "exact_bytes"]]);

/** Reconstruct only LF/CRLF representations; never accept arbitrary JSON reserialization. */
export function referenceCompatibility(artifact) {
  const reason = artifact.reference_version !== current.reference_version ? "reference_version_mismatch"
    : !representations.has(artifact.reference_sha256) ? "unknown_reference_bytes"
    : artifact.reference && !isDeepStrictEqual(artifact.reference, current) ? "embedded_reference_mismatch"
    : artifact.reference_sha256 !== sha256(bytes) && !artifact.reference ? "missing_embedded_reference"
    : representations.get(artifact.reference_sha256);
  return { accepted: ["exact_bytes", "verified_line_endings"].includes(reason), reason,
    historical_sha256: artifact.reference_sha256 ?? null, current_sha256: sha256(bytes),
    approval_transferred: false };
}
