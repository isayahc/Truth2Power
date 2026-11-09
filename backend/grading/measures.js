import { readFileSync } from "node:fs";
import { hhs } from "./data.js";

const uniformReference = JSON.parse(readFileSync(new URL("../../references/whole-form-wave-one-v1.json", import.meta.url)));
const text = (value) => typeof value === "string" && !!value.trim();
const list = (value) => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
const number = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const outcome = (pass) => pass ? "yes" : "no";
const neutral = "not_addressed";
const isCase = (name, pass, fail) => (v) => v[name] === pass ? "yes" : v[name] === fail ? "no" : v[name] === neutral ? neutral : "unclear";

/** Compare known cells independently of maximum eligible income. Partial matching tables cannot pass. */
export function fplComparison(value, year) {
  const ref = hhs.years[year], cells = [], seen = new Set();
  if (!ref || !value || value.currency !== "USD" || value.period !== "annual" || !Array.isArray(value.cells) ||
      !(value.published_year === null || (Number.isInteger(value.published_year) && value.published_year >= 1900 && value.published_year <= 2200))) return { result: "unclear", cells };
  for (const row of value.cells) {
    const { household_size: size, fpl_percent: pct, amount } = row ?? {};
    const key = size + "/" + pct;
    if (!Number.isSafeInteger(size) || size < 1 || ![200, 300, 400].includes(pct) || !Number.isSafeInteger(amount) || amount < 0 || seen.has(key))
      return { result: "unclear", cells };
    seen.add(key);
    const base = size <= 8 ? ref.household_amounts[size - 1] : ref.household_amounts[7] + (size - 8) * ref.additional_person;
    cells.push({ household_size: size, fpl_percent: pct, observed: amount, expected: base * pct / 100 });
  }
  const wrongYear = value.published_year !== null && value.published_year !== year;
  if (wrongYear || cells.some((c) => c.observed !== c.expected)) return { result: "no", cells };
  const complete = ref.household_amounts.every((_, i) => [200, 300, 400].every((pct) => seen.has((i + 1) + "/" + pct)));
  return { result: complete && value.published_year === year ? "yes" : "unclear", cells };
}

const checks = {
  deadline: isCase("application_submission", "any_time", "time_limit"),
  assets: isCase("eligibility_asset_test", "no_asset_test", "assets_tested"),
  immigration: isCase("immigration_eligibility", "regardless_of_status", "status_restricts_eligibility"),
  contact(v) {
    if (v.complete !== true || !Array.isArray(v.channels)) return "unclear";
    if (!v.channels.length) return "no";
    return v.channels.some((c) => c?.purpose === "application_assistance" && ["telephone", "email", "office", "url"].includes(c.type) && text(c.value)) ? "yes" : "unclear";
  },
  tables(v) {
    return v.complete === true && typeof v.income_table === "boolean" && typeof v.discount_table === "boolean" ? outcome(v.income_table && v.discount_table) : "unclear";
  },
  maximum(v, expected) {
    if (!number(v.percent) || typeof v.hard_ceiling !== "boolean") return "unclear";
    return v.percent >= expected.minimum_percent ? "yes" : v.hard_ceiling ? "no" : "unclear";
  },
  installments(v, expected) {
    if (v.explicitly_uncapped === true && v.basis === expected.basis && v.percent === null) return "no";
    return number(v.percent) && v.basis === expected.basis ? outcome(v.percent <= expected.maximum_percent) : "unclear";
  },
  summary_area(v) { return v.complete === true && list(v.areas) ? outcome(v.areas.length > 0) : "unclear"; },
  summary_process(v) { return v.complete === true && list(v.application_instructions) ? outcome(v.application_instructions.length > 0) : "unclear"; },
  summary_income(v) { return v.complete === true && Array.isArray(v.fpl_levels) && v.fpl_levels.every(number) ? outcome(v.fpl_levels.length > 0) : "unclear"; },
};

function combine(results) {
  const meaningful = new Set(results.filter((v) => v !== neutral));
  return meaningful.size === 1 ? [...meaningful][0] : "unclear";
}

function posting(measure, input, facts) {
  const targets = measure.expected.any_accessible_role;
  const pages = input.sources.filter((d) => d.role === "landing_page");
  let complete = pages.length > 0;
  for (const page of pages) {
    if (!page.snapshot || !["reviewed", "available"].includes(page.status)) { complete = false; continue; }
    const inventory = facts.get(page.source_id);
    if (!inventory || !list(inventory.links) || inventory.search_complete !== true || !text(inventory.search_notes) || page.status !== "reviewed") complete = false;
    if (inventory && list(inventory.links) && inventory.links.some((url) => input.sources.some((d) =>
      d.source_id === url && targets.includes(d.role) && d.snapshot && !["unavailable", "unreadable"].includes(d.status)))) return "yes";
  }
  if (input.sources.some((d) => targets.includes(d.role))) return "unclear";
  return complete && input.scope.inventory_status === "complete" && !input.scope.gaps.length ? "no" : "unclear";
}

function consistent(values) {
  const terms = new Map();
  let comparisons = 0;
  for (const v of values) {
    if (v.complete !== true || !v.terms || Array.isArray(v.terms) || typeof v.terms !== "object") return "unclear";
    for (const [term, value] of Object.entries(v.terms)) {
      if (!(text(value) || number(value))) return "unclear";
      if (!terms.has(term)) terms.set(term, []);
      terms.get(term).push(value);
    }
  }
  for (const values of terms.values()) {
    if (new Set(values).size > 1) return "no";
    if (values.length > 1) comparisons++;
  }
  return comparisons && values.every((v) => Object.keys(v.terms).some((k) => terms.get(k).length > 1) || v.no_comparable_terms === true) ? "yes" : "unclear";
}

function compareReference(measure, input, docs, facts) {
  const uniform = measure.evaluator === "uniform";
  const references = docs.filter((d) => d.role === (uniform ? "uniform_reference" : "psa_reference"));
  const publications = docs.filter((d) => !references.includes(d));
  if (references.length !== 1 || publications.length === 0) return "unclear";
  const ref = references[0], authority = facts.get(ref.source_id);
  if (!input.synthetic && (!uniform || ref.snapshot.sha256 !== uniformReference.reference_sha256)) return "unclear";
  if (!text(authority.version) || authority.guideline_year !== input.guideline_year) return "unclear";
  const required = uniform ? authority.required_sections : authority.required_counties;
  if (!list(required) || !required.length) return "unclear";
  return combine(publications.map((doc) => {
    const v = facts.get(doc.source_id);
    const observed = uniform ? v.present_sections : v.published_counties;
    if (!list(observed) || v.complete !== true) return "unclear";
    if (uniform && (v.customizations !== "none" || v.visual_review_complete !== true)) return "unclear";
    return outcome(required.every((item) => observed.includes(item)));
  }));
}

/** Evaluate each measure once. Missing translations and competing document observations stay visible. */
export function evaluateMeasure(measure, input, facts) {
  const docs = input.sources.filter((d) => measure.roles.includes(d.role));
  const gaps = [], comparisons = [], document_results = [];
  let result;
  if (measure.evaluator === "posting") {
    result = posting(measure, input, facts);
  } else {
    if (!docs.length) gaps.push("No applicable document was identified.");
    for (const doc of docs) {
      if (doc.status !== "reviewed" || !facts.has(doc.source_id)) gaps.push(`Review ${doc.role} [${doc.language}] ${doc.source_id} for this measure.`);
    }
    if (measure.evaluator === "consistency" && input.scope.online_application === "unknown") gaps.push("Establish online application coverage.");
    gaps.push(...input.scope.gaps);
    const perDocument = measure.evaluator === "fpl" || Object.hasOwn(checks, measure.evaluator);
    if (perDocument) {
      for (const doc of docs) {
        const value = facts.get(doc.source_id);
        if (doc.status !== "reviewed" || !value || typeof value !== "object" || Array.isArray(value)) continue;
        let local;
        if (measure.evaluator === "fpl") {
          const comparison = fplComparison(value, input.guideline_year);
          comparisons.push({ source_id: doc.source_id, ...comparison });
          local = comparison.result;
        } else local = checks[measure.evaluator](value, measure.expected);
        document_results.push({ source_id: doc.source_id, language: doc.language, result: local });
      }
      if (!gaps.length && document_results.length === docs.length) result = combine(document_results.map((d) => d.result));
    } else if (!gaps.length && docs.length) {
      const values = docs.map((d) => facts.get(d.source_id));
      if (values.some((v) => v === null || typeof v !== "object" || Array.isArray(v))) result = "unclear";
      else if (measure.evaluator === "consistency") {
        const landing = docs.filter((d) => d.role === "landing_page");
        if (input.scope.online_application === "absent_after_search" && (!landing.length ||
            !landing.every((d) => facts.get(d.source_id).online_application_search === "searched_absent"))) {
          gaps.push("Cite the completed search for an online application.");
        } else result = consistent(values);
      } else result = compareReference(measure, input, docs, facts);
    }
  }
  if (!result || result === "unclear") gaps.push(measure.evidence_requirement);
  return { result: result ?? "unclear", gaps, comparisons, document_results };
}
