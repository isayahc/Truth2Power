import { test } from "node:test"
import assert from "node:assert/strict"
import { validateServiceArea } from "./validate.ts"
import { determineServiceArea } from "./result.ts"
import { loadServiceAreaReference } from "./reference.ts"
import type { ReviewSource } from "../../shared/review-sources.ts"
import { boundedDiscoveryGap } from "../../shared/review-sources.ts"

const source: ReviewSource = {
  id: "SYN-1", roles: ["policy_statement"],
  snapshot: { snapshot_id: "synthetic", sha256: "synthetic", sourceUrl: "https://example.org/policy.pdf",
    finalUrl: "https://example.org/policy.pdf", path: "synthetic.pdf", kind: "pdf", bytes: 1, httpStatus: 200,
    retrievedAt: "2026-11-11T00:00:00Z" },
  passages: [{ locator: "PDF page 1", text: "Financial assistance for medically necessary services covers residents of Alpha and Beta counties. Emergency assistance covers New York residents." }],
}
const observation = { serviceType: "medically_necessary", geographyType: "county", areas: ["Alpha", "Beta"], completeCountyList: true,
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
    serviceType: "emergency", geographyType: "other", areas: ["New York"], completeCountyList: false,
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

test("readable policy silence is not met even without a facility authority", () => {
  const reading = validateServiceArea(JSON.stringify({observations:[],limitations:[]}),source)
  const result = determineServiceArea([{taskId:"SYN-silence",source,reading}],undefined,[boundedDiscoveryGap])
  assert.equal(result.value,false)
  assert.equal(result.reason_code,"primary_service_boundaries_not_disclosed")
  assert.equal(result.reviewed_sources[0].sourceUrl,source.snapshot.sourceUrl)
  assert.ok(result.limitations.includes(boundedDiscoveryGap))
})

test("emergency-only counties and broad non-emergency regions do not satisfy disclosure", () => {
  for (const candidate of [
    {...observation,serviceType:"emergency"},
    {...observation,geographyType:"other"},
    {...observation,serviceType:"unspecified"},
  ]) {
    const reading=validateServiceArea(JSON.stringify({observations:[candidate],limitations:[]}),source)
    assert.equal(determineServiceArea([{taskId:"SYN-geography",source,reading}],undefined,[]).value,false)
  }
})

test("explicit primary-service ZIP codes satisfy disclosure but not full boundary compliance", () => {
  const text="Financial assistance for non-emergency services covers residents of ZIP codes 12345 and 12346."
  const zipSource={...source,passages:[{locator:"PDF page 1",text}]}
  const reading=validateServiceArea(JSON.stringify({observations:[{...observation,geographyType:"zip_code",areas:["12345","12346"],
    completeCountyList:false,evidence:[{locator:"PDF page 1",quote:text}]}],limitations:[]}),zipSource)
  const result=determineServiceArea([{taskId:"SYN-zip",source:zipSource,reading}],undefined,[])
  assert.equal(result.disclosure.explicit_counties_or_zip_codes,true)
  assert.equal(result.value,null)
})

test("failed, ambiguous or missing policy reviews remain unclear rather than hospital failures", () => {
  const reading={observations:[],limitations:[]}
  const entry={taskId:"SYN-gap",source,reading}
  assert.equal(determineServiceArea([entry],undefined,["SYN source extraction failed"]).value,null)
  assert.equal(determineServiceArea([{...entry,reading:{...reading,limitations:["SYN ambiguous scope"]}}],undefined,[]).value,null)
  assert.equal(determineServiceArea([{...entry,source:{...source,roles:["landing_page"]}}],undefined,[]).value,null)
  assert.throws(()=>validateServiceArea(JSON.stringify({observations:[{...observation,geographyType:"invented"}],limitations:[]}),source),/Invalid geographic observation/)
})
