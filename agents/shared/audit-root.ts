import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** CLI and hosted workers must read and write the same persistent evidence tree. */
export function auditRoot() {
  return resolve(process.env.AUDIT_DIR || fileURLToPath(new URL("../../.audit/", import.meta.url)))
}
