// Audit-overview read API — same fetch path the old app used.
import { getJson } from "./client.js";

export function overview(signal) {
  return getJson("/api/overview", signal);
}
