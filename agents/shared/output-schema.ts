import { readFile } from "node:fs/promises"

export async function loadOutputSchema() {
  const contract = JSON.parse(await readFile(new URL("../../schemas/live-audit-v1.schema.json", import.meta.url), "utf8"))
  return {
    type: "object", additionalProperties: false, required: ["findings"],
    properties: { findings: { type: "array", items: { $ref: "#/$defs/finding" } } },
    $defs: { finding: contract.$defs.finding, citation: contract.$defs.citation },
  }
}
