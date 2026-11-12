import { test } from "node:test"
import assert from "node:assert/strict"
import { validateServiceArea } from "./validate.ts"
import { determineServiceArea } from "./result.ts"
import { loadServiceAreaReference } from "./reference.ts"
import type { ReviewSource } from "../../shared/review-sources.ts"

const source: ReviewSource = {
  id: "SYN-1", roles: ["policy_statement"],
  snapshot: { snapshot_id: "synthetic", sha256: "synthetic", sourceUrl: "https://example.org/policy.pdf",
    finalUrl: "https://example.org/policy.pdf", path: "synthetic.pdf", kind: "pdf", bytes: 1, httpStatus: 200,
    retrievedAt: "2026-11-11T00:00:00Z" },
  passages: [{ locator: "PDF page 1", text: "Financial assistance for medically necessary services covers residents of Alpha and Beta counties. Emergency assistance covers New York residents." }],
}
const observation = { serviceType: "medically_necessary", areas: ["Alpha", "Beta"], completeCountyList: true,
  evidence: [{ locator: "PDF page 1", quote: "Financial assistance for medically necessary services covers residents of Alpha and Beta counties." }] }

test("geographic observations require actual quoted areas and correct source locations", () => {
  const valid = { observations: [observation], limitations: [] }
  assert.equal(validateServiceArea(JSON.stringify(valid), source).observations.length, 1)
  assert.throws(() => validateServiceArea(JSON.stringify({ ...valid, observations: [{ ...observation, areas: ["Gamma"] }] }), source), /Geographic name/)
  assert.throws(() => validateServiceArea(JSON.stringify({ ...valid, observations: [{ ...observation,
    evidence: [{ locator: "PDF page 2", quote: observation.evidence[0].quote }] }] }), source), /quotation/)
  assert.throws(() => validateServiceArea(JSON.stringify({ ...valid, observations: [{ ...observation, serviceType: "all" }] }), source))
})

test("emergency and medically necessary geography remain distinct", () => {
  const reading = validateServiceArea(JSON.stringify({ observations: [observation, {
    serviceType: "emergency", areas: ["New York"], completeCountyList: false,
    evidence: [{ locator: "PDF page 1", quote: "Emergency assistance covers New York residents." }],
  }], limitations: [] }), source)
  const result = determineServiceArea([{ taskId: "source-1:geography", source, reading }], undefined, [])
  assert.deepEqual(result.observations.map(o => o.serviceType), ["medically_necessary", "emergency"])
  assert.equal(result.value, null)
  assert.equal(result.evidence.length, 2)
})

test("county presence or mismatch alone cannot become a compliance verdict", () => {
  const reading = validateServiceArea(JSON.stringify({ observations: [observation], limitations: [] }), source)
  for (const counties of [["Alpha", "Beta"], ["Gamma"]]) {
    const result = determineServiceArea([{ taskId: "source-1:geography", source, reading }], {
      status: "verified", requiredCounties: counties, evidence: [], limitations: ["Applicability approval pending"],
    }, [])
    assert.equal(result.value, null)
    assert.equal(result.comparisons.length, 1)
  }
  assert.equal(determineServiceArea([], undefined, ["All sources failed"]).value, null)
})

test("missing authority and invalid dates are explicit", async () => {
  const hospital = { id: "SYN-1", name: "Synthetic Hospital", financialAssistanceUrl: "https://example.org/aid" }
  const reference = await loadServiceAreaReference(hospital, "2026-11-11", process.cwd())
  assert.equal(reference.status, "missing")
  assert.equal(reference.requiredCounties.length, 0)
  assert.ok(reference.limitations.length)
  await assert.rejects(() => loadServiceAreaReference(hospital, "not-a-date", process.cwd()))
})
