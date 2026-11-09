import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseProfile } from "../grading/profiles.js";
import { referenceCompatibility } from "../grading/reference-compatibility.js";
import { sha256 } from "../review/identity.js";
import { fplComparison } from "../grading/measures.js";

const coverage = JSON.parse(readFileSync('docs/validation/wave-one-application-reviews.json'));
test('seven source-language profiles agree with Python source-specific numeric outcomes', () => {
  assert.equal(coverage.reviews.length, 7);
  for (const review of coverage.reviews) {
    for (const name of ['fpl', 'maximum', 'installments']) {
      const facts = review.extraction.map((s) => parseProfile(name, s.text, review.language)).filter(Boolean);
      assert.equal(facts.length, 1, `${review.hospital_key}/${review.language}/${name}`);
      if (name === 'fpl') {
        assert.equal(facts[0].cells.length, review.hospital_key === '1002' ? 21 : 24);
        assert.equal(fplComparison(facts[0], 2026).result, review.hospital_key === '1002' ? 'no' : 'yes');
      } else assert.equal(facts[0].percent, name === 'maximum' ? 400 : 5);
    }
  }
});

test('reference compatibility accepts only verified byte representations and preserves original objects', () => {
  const bytes = readFileSync('references/hhs-poverty-contiguous-v1.json');
  const reference = JSON.parse(bytes);
  const artifact = { reference, reference_version: reference.reference_version,
    reference_sha256: sha256(Buffer.from(bytes.toString().replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'))) };
  const before = structuredClone(artifact);
  const accepted = referenceCompatibility(artifact);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.approval_transferred, false);
  assert.deepEqual(artifact, before);
  assert.equal(referenceCompatibility({ ...artifact, reference_sha256: '0'.repeat(64) }).accepted, false);
  assert.equal(referenceCompatibility({ ...artifact, reference_version: 'SYN-other' }).accepted, false);
  const changed = structuredClone(artifact); changed.reference.years['2026'].household_amounts[0]++;
  assert.equal(referenceCompatibility(changed).reason, 'embedded_reference_mismatch');
  assert.equal(referenceCompatibility({ ...artifact, reference_sha256: sha256(bytes) }).accepted, true);
});

test('language mismatch, duplicate tables and ambiguous statements remain unknown', () => {
  const spanish = coverage.reviews.find((r) => r.hospital_key === '362' && r.language === 'es').extraction[0].text;
  assert.equal(parseProfile('fpl', spanish, 'en'), null);
  assert.equal(parseProfile('fpl', spanish, 'und'), null);
  assert.equal(parseProfile('fpl', spanish + '\n' + spanish, 'es'), null);
  assert.equal(parseProfile('installments', spanish.replace('no pueden exceder', 'pueden exceder'), 'es'), null);
  const altered = parseProfile('fpl', spanish.replace('$133,080', '$133,880'), 'es');
  assert.equal(fplComparison(altered, 2026).result, 'no');
});
