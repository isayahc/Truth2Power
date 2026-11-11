package com.truth2power.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.truth2power.config.RepoPaths;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Port of backend/hospital-page/service.js — builds one hospital's
 * measure-by-measure page from the local review records, the two baseline
 * assessments (1002, 362), the designated summary-posting reassessment,
 * and any published pipeline assessments.
 */
@Service
public class HospitalPageService {

    private static final String LAW_URL = "https://www.nysenate.gov/legislation/laws/PBH/2807-K";

    /** CSS column -> [question, law section, plain-language explanation]. Verbatim from the Node service. */
    private static final Map<String, String[]> EXPLANATIONS = Map.ofEntries(
            Map.entry("R", new String[]{"Can patients find a financial assistance application?", "§ 2807-k(9), (9-a)(e)", "The law requires the state form and help applying. Website posting is the CSS audit check."}),
            Map.entry("S", new String[]{"Can patients find a plain-language summary?", "§ 2807-k(9-a)(c)", "Patients must be able to get a clear summary of the hospital's financial aid policy."}),
            Map.entry("T", new String[]{"Can patients find the financial assistance policy?", "§ 2807-k(9-a)(a), (c)", "Hospitals must have written financial aid policies. Posting the full policy is the CSS audit check."}),
            Map.entry("U", new String[]{"Do the documents give patients the same information?", "§ 2807-k(9-a)(c), (d)", "Policies must be understandable and applied consistently. The audit compares documents for conflicting terms."}),
            Map.entry("V", new String[]{"Does the hospital's service area follow the applicable rules?", "§ 2807-k(9-a)(f)", "Statewide emergency coverage and primary-service-area rules apply. An independent boundary reference is needed to decide this check."}),
            Map.entry("W", new String[]{"Can patients apply throughout the collection process?", "§ 2807-k(9-a)(e)", "Patients must be allowed to apply at any time during the collection process."}),
            Map.entry("Y", new String[]{"Is assistance free of an asset eligibility check?", "§ 2807-k(9-a)(b), (f) — related income rules", "This CSS check looks for asset-based eligibility barriers. The exact legal interpretation remains subject to policy review."}),
            Map.entry("Z", new String[]{"Can patients qualify regardless of immigration status?", "§ 2807-k(9-a)(a)", "Immigration status must not be used to decide financial assistance eligibility."}),
            Map.entry("AD", new String[]{"Does the hospital use the full New York State application?", "§ 2807-k(9)", "Hospitals must use the uniform financial assistance form provided by the state."}),
            Map.entry("AE", new String[]{"Does the application tell patients whom to contact?", "§ 2807-k(9), (9-a)(e)", "Hospitals must help patients understand the policy and apply. The audit checks the form's contact information."}),
            Map.entry("AG", new String[]{"Does the application show income and discount tables?", "§ 2807-k(9), (9-a)(b)", "The state form and income-based discounts help patients understand what they may pay."}),
            Map.entry("AH", new String[]{"Does the application use the review year's poverty guidelines?", "§ 2807-k(9-a)(b)", "Discounts depend on federal poverty levels. This audit compares the form with the review year's federal amounts."}),
            Map.entry("AI", new String[]{"Does assistance cover incomes through 400% of the poverty level?", "§ 2807-k(9-a)(b), (f)", "The required income-based assistance reaches the 400% federal poverty level threshold."}),
            Map.entry("AJ", new String[]{"Are monthly installments capped at 5% of gross monthly income?", "§ 2807-k(9-a)(d)", "Monthly payments under the financial aid installment plan cannot exceed 5% of income before deductions."}),
            Map.entry("AL", new String[]{"Does the summary describe the area the hospital serves?", "§ 2807-k(9-a)(c)", "The summary must describe the hospital's primary service area."}),
            Map.entry("AM", new String[]{"Does the summary explain how to apply?", "§ 2807-k(9-a)(c)", "The summary must explain the means of applying for assistance."}),
            Map.entry("AN", new String[]{"Does the summary state the income levels for assistance?", "§ 2807-k(9-a)(c)", "The summary must include the income levels used to decide eligibility."}));

    private final RepoPaths paths;
    private final JsonNode rubric;
    private final List<ObjectNode> baseline;

    public HospitalPageService(RepoPaths paths) {
        this.paths = paths;
        Path repoRoot = paths.dataDir().getParent();
        try {
            this.rubric = Json.readFile(repoRoot.resolve("rubrics/css-17-v1.json"));
            List<ObjectNode> base = new ArrayList<>();
            for (String key : List.of("1002", "362")) {
                JsonNode doc = Json.readFile(repoRoot.resolve("docs/hospital-pages/" + key + ".json"));
                for (JsonNode r : Json.array(doc, "records")) base.add((ObjectNode) r.deepCopy());
            }
            Path successorPath = repoRoot.resolve("docs/audit-format/changes/362-summary-posting.json");
            byte[] raw = Files.readAllBytes(successorPath);
            ObjectNode successor = LocalRecords.projectRecord(raw, "docs/audit-format/changes/362-summary-posting.json", "posting");
            successor.put("scope_label", "Posting reassessment · designated summary page and both linked summaries");
            base.add(successor);
            this.baseline = base;
        } catch (IOException e) {
            throw new IllegalStateException("Hospital page reference data could not be loaded", e);
        }
    }

    public record PageInputs(List<ObjectNode> records, List<String> unavailable) {}

    /** One consistent set of input records for an entire request — mirrors pageInputs(). */
    public PageInputs pageInputs() {
        LocalRecords.LocalResult local = LocalRecords.localRecords(paths.auditLiveDir());
        Map<String, ObjectNode> merged = new LinkedHashMap<>();
        for (ObjectNode r : local.records()) merged.put(Json.text(r, "record_id"), r);
        for (ObjectNode r : baseline) merged.put(Json.text(r, "record_id"), r);
        List<ObjectNode> records = new ArrayList<>(merged.values());
        records.addAll(PipelineViews.publishedRecords(paths.auditDir(), paths.auditLiveDir()));
        return new PageInputs(records, local.unavailable());
    }

    public ObjectNode hospitalPage(String key) {
        return hospitalPage(key, pageInputs(), 2026);
    }

    public ObjectNode hospitalPage(String key, PageInputs inputs, int year) {
        List<ObjectNode> all = new ArrayList<>();
        for (ObjectNode r : inputs.records()) {
            if (key.equals(Json.text(r, "hospital_key")) && r.get("guideline_year").asInt() == year) all.add(r);
        }
        boolean hasPipelineCompleted = all.stream().anyMatch(r ->
                "pipeline".equals(Json.text(r, "kind")) && "completed".equals(Json.text(r, "status")));
        if (hasPipelineCompleted) {
            all.removeIf(r -> !"pipeline".equals(Json.text(r, "kind")));
        }
        if (all.isEmpty() && !List.of("1002", "362").contains(key)) return null;
        ObjectNode integrated = null;
        for (ObjectNode r : all) {
            if ("pipeline".equals(Json.text(r, "kind")) && "completed".equals(Json.text(r, "status"))) {
                integrated = r;
                break;
            }
        }
        String revision;
        if (integrated != null) {
            revision = Json.text(integrated, "record_id");
        } else {
            List<String> ids = new ArrayList<>();
            for (ObjectNode r : all) ids.add(Json.text(r, "record_id"));
            ids.sort(String::compareTo);
            List<Object> input = new ArrayList<>();
            input.add(key);
            input.add(year);
            input.add(ids);
            revision = Json.sha256Hex(Json.stringify(input));
        }
        List<ObjectNode> scopes = LocalRecords.latestByScope(all);
        ArrayNode measures = Json.MAPPER.createArrayNode();
        List<String> failedMeasures = new ArrayList<>();
        for (JsonNode m : Json.array(rubric, "measures")) {
            String measureId = Json.text(m, "measure_id");
            String column = Json.text(m, "css_column");
            ArrayNode versions = Json.MAPPER.createArrayNode();
            for (ObjectNode s : scopes) {
                JsonNode latest = s.get("latest");
                if (!measureId.equals(Json.text(latest, "measure_id"))) continue;
                JsonNode success = s.get("success");
                boolean hasSuccess = success != null && !success.isNull();
                ObjectNode v = Json.MAPPER.createObjectNode();
                v.put("scope", Json.text(latest, "scope"));
                String label = hasSuccess ? Json.text(success, "scope_label") : null;
                if (label == null) label = Json.text(latest, "scope_label");
                if (label == null) label = Json.text(latest, "scope");
                v.put("label", label);
                if (hasSuccess && success.hasNonNull("finding")) v.set("finding", success.get("finding"));
                else v.putNull("finding");
                if (hasSuccess && Json.text(success, "checked_at") != null) v.put("assessed_at", Json.text(success, "checked_at"));
                else v.putNull("assessed_at");
                if (hasSuccess && Json.text(success, "review_date") != null) v.put("review_date", Json.text(success, "review_date"));
                else v.putNull("review_date");
                if (hasSuccess && Json.text(success, "record_id") != null) v.put("record_id", Json.text(success, "record_id"));
                else v.putNull("record_id");
                v.put("human_review_status", "Original draft; see review inbox for separate human decisions");
                ArrayNode failures = Json.MAPPER.createArrayNode();
                for (JsonNode f : Json.array(s, "failures")) {
                    ObjectNode nf = Json.MAPPER.createObjectNode();
                    nf.put("attempted_at", Json.text(f, "checked_at"));
                    nf.put("reason", hasSuccess ? Json.text(f, "error")
                            : "The recheck failed; no successful finding is available for this scope.");
                    failures.add(nf);
                }
                v.set("failures", failures);
                versions.add(v);
            }
            java.util.Set<String> results = new java.util.HashSet<>();
            for (JsonNode v : versions) {
                JsonNode finding = v.get("finding");
                String res = finding != null && !finding.isNull() && Json.text(finding, "result") != null
                        ? Json.text(finding, "result") : "unclear";
                results.add(res);
            }
            String result = results.size() == 1 ? results.iterator().next() : "unclear";
            String[] expl = EXPLANATIONS.get(column);
            String question = expl[0];
            String section = expl[1];
            String plainLanguage = expl[2];
            String reason;
            if (versions.isEmpty()) {
                reason = "No successful saved assessment for this measure. Review needed.";
            } else if (results.size() > 1) {
                reason = "Document or language scopes have different results. Read each scope below.";
            } else {
                JsonNode firstFinding = versions.get(0).get("finding");
                String exp = firstFinding != null && !firstFinding.isNull() ? Json.text(firstFinding, "explanation") : null;
                reason = exp != null ? exp : "The recheck failed before a successful assessment was saved.";
            }
            ObjectNode measure = Json.MAPPER.createObjectNode();
            if (integrated != null) {
                for (JsonNode af : Json.array(integrated, "agent_findings")) {
                    if (measureId.equals(Json.text(af, "measure_id"))) {
                        measure.set("agent_finding", af);
                        break;
                    }
                }
            }
            measure.put("measure_id", measureId);
            measure.put("column", column);
            measure.put("title", Json.text(m, "title"));
            measure.put("question", question);
            measure.put("result", result);
            measure.put("reason", reason);
            ObjectNode law = Json.MAPPER.createObjectNode();
            law.put("url", LAW_URL);
            law.put("section", section);
            law.put("plain_language", plainLanguage);
            law.put("interpretation_status", "Informational mapping; subject-matter review pending (#67)");
            law.put("revision", "2026-05-29");
            measure.set("law", law);
            measure.set("versions", versions);
            measures.add(measure);
            boolean failed = false;
            for (JsonNode v : versions) {
                JsonNode finding = v.get("finding");
                if (finding != null && !finding.isNull() && "no".equals(Json.text(finding, "result"))) {
                    failed = true;
                    break;
                }
            }
            if (failed) failedMeasures.add(measureId);
        }
        List<String> successes = new ArrayList<>();
        for (ObjectNode s : scopes) {
            JsonNode success = s.get("success");
            if (success != null && !success.isNull() && Json.text(success, "checked_at") != null) {
                successes.add(Json.text(success, "checked_at"));
            }
        }
        successes.sort((x, y) -> Json.parseDate(y).compareTo(Json.parseDate(x)));
        List<ObjectNode> landingPages = new ArrayList<>();
        for (ObjectNode r : all) {
            for (JsonNode lp : Json.array(r, "landing_page")) {
                if (Json.validDate(Json.text(lp, "retrieved_at"))) landingPages.add((ObjectNode) lp);
            }
        }
        landingPages.sort((x, y) -> Json.parseDate(Json.text(y, "retrieved_at"))
                .compareTo(Json.parseDate(Json.text(x, "retrieved_at"))));
        ObjectNode landing = landingPages.isEmpty() ? null : landingPages.get(0);

        ObjectNode page = Json.MAPPER.createObjectNode();
        page.put("hospital_key", key);
        page.put("revision", revision);
        page.put("guideline_year", year);
        page.putNull("current_grade");
        page.put("synthetic", integrated != null && integrated.path("synthetic").asBoolean(false));
        if (integrated != null) {
            if (Json.text(integrated, "monitoring_at") != null) page.put("monitoring_at", Json.text(integrated, "monitoring_at"));
            else page.putNull("monitoring_at");
            page.put("audit_mode", Json.text(integrated, "audit_mode"));
            JsonNode report = integrated.get("report");
            boolean coverageComplete = report != null
                    && report.path("coverage_gaps").size() == 0
                    && report.path("unresolved_measures").size() == 0;
            page.put("evidence_complete", coverageComplete);
        }
        page.put("integrated_report_url", integrated != null ? "/api/pilot/assessments/" + revision : null);
        if (integrated == null) page.putNull("integrated_report_url");
        page.put("grade_note", integrated != null
                ? "Integrated 17-measure assessment completed (" + Json.text(integrated, "audit_mode")
                        + "). Institutional grade and human authorization remain pending. Saved-evidence replay does not assert a new website capture."
                : "Current institutional grade pending. These source-scoped drafts are not a single approved hospital assessment.");
        page.put("latest_successful_assessment_at", successes.isEmpty() ? null : successes.get(0));
        if (successes.isEmpty()) page.putNull("latest_successful_assessment_at");
        if (landing != null) {
            if (Json.text(landing, "publisher_updated_at") != null) page.put("publisher_updated_at", Json.text(landing, "publisher_updated_at"));
            else page.putNull("publisher_updated_at");
            if (Json.text(landing, "url") != null) page.put("publisher_page_url", Json.text(landing, "url"));
            else page.putNull("publisher_page_url");
            page.put("landing_retrieved_at", Json.text(landing, "retrieved_at"));
        } else {
            page.putNull("publisher_updated_at");
            page.putNull("publisher_page_url");
            page.putNull("landing_retrieved_at");
        }
        page.put("unavailable_records", inputs.unavailable().size());
        page.set("measures", measures);
        ArrayNode failed = Json.MAPPER.createArrayNode();
        for (String id : failedMeasures) failed.add(id);
        page.set("failed_measures", failed);
        return page;
    }
}
