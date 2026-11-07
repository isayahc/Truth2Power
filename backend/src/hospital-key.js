// This URL identifies the original source row in the frozen September 2025 audit.
const fallbackBySourceRow = new Map([
  ["https://docs.google.com/spreadsheets/d/17S2EheUVVr1g911fPpBQJqRpy18pkUlaEEnvGM0LB1o/edit#gid=504145376&range=A31:AQ31", "t2p-0001"],
]);

/** Resolve the roster key from an audit record, independently of its display name. */
export function hospitalKey(record) {
  const pfi = record.hospital.permanent_facility_identifier;
  if (typeof pfi === "string" && /^\d+$/.test(pfi)) return pfi;
  if (pfi != null && pfi !== "") throw new Error("Invalid hospital PFI");
  const fallback = fallbackBySourceRow.get(record.source.row_url);
  if (!fallback) throw new Error("Assign a stable local key to the unregistered source row");
  return fallback;
}
