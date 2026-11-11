package com.truth2power.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.truth2power.config.RepoPaths;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Port of backend/overview/service.js — aggregates one hospital-page
 * revision per roster hospital into the audit overview: freshness, grades,
 * findings, and per-region breakdowns.
 */
@Service
public class OverviewService {

    private static final int WINDOW_DAYS = 30;
    private static final List<String> GRADES = List.of("A", "B", "C", "D", "F");

    private final RepoPaths paths;
    private final HospitalPageService pages;
    private final JsonNode roster;
    private final Map<String, String> regionByCounty;
    private final List<String> regions;

    public OverviewService(RepoPaths paths, HospitalPageService pages) {
        this.paths = paths;
        this.pages = pages;
        try {
            this.roster = Json.readFile(paths.mapsDir().resolve("hospitals.geojson")).get("features");
            JsonNode regionsDoc = Json.readFile(paths.dataDir().getParent()
                    .resolve("references/ny-economic-regions-v1.json"));
            Map<String, String> byCounty = new LinkedHashMap<>();
            List<String> regionNames = new ArrayList<>();
            for (var field : Json.fields(regionsDoc.get("regions"))) {
                regionNames.add(field.getKey());
                for (JsonNode county : field.getValue()) {
                    byCounty.put(countyKey(county.asText()), field.getKey());
                }
            }
            this.regionByCounty = byCounty;
            this.regions = regionNames;
        } catch (Exception e) {
            throw new IllegalStateException("Overview reference data could not be loaded", e);
        }
    }

    private static String countyKey(String name) {
        return name.replace(".", "").toLowerCase(java.util.Locale.ROOT);
    }

    public ObjectNode overview() {
        return overview(Instant.now());
    }

    public ObjectNode overview(Instant asOf) {
        HospitalPageService.PageInputs inputs = pages.pageInputs();
        Map<String, List<ObjectNode>> byHospital = new LinkedHashMap<>();
        for (ObjectNode r : inputs.records()) {
            byHospital.computeIfAbsent(Json.text(r, "hospital_key"), k -> new ArrayList<>()).add(r);
        }
        ArrayNode hospitals = Json.MAPPER.createArrayNode();
        for (JsonNode feature : roster) {
            String key = feature.get("id").asText();
            List<ObjectNode> records = byHospital.getOrDefault(key, List.of());
            ObjectNode page = pages.hospitalPage(key,
                    new HospitalPageService.PageInputs(records, inputs.unavailable()), 2026);
            hospitals.add(hospitalRow(feature, page, asOf));
        }
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.put("as_of", Json.toIso(asOf));
        out.put("guideline_year", 2026);
        out.put("window_days", WINDOW_DAYS);
        out.put("unavailable_records", inputs.unavailable().size());
        out.set("hospitals", hospitals);
        out.set("statewide", summarize(hospitals));
        ArrayNode regionRows = Json.MAPPER.createArrayNode();
        for (String region : regions) {
            ArrayNode filtered = Json.MAPPER.createArrayNode();
            for (JsonNode h : hospitals) {
                if (region.equals(Json.text(h, "region"))) filtered.add(h);
            }
            ObjectNode row = Json.MAPPER.createObjectNode();
            row.put("region", region);
            row.setAll(summarize(filtered));
            regionRows.add(row);
        }
        out.set("regions", regionRows);
        return out;
    }

    private ObjectNode hospitalRow(JsonNode feature, ObjectNode page, Instant asOf) {
        JsonNode p = feature.get("properties");
        String id = feature.get("id").asText();
        String last = page == null ? null : Json.text(page, "latest_successful_assessment_at");
        String monitoring = null;
        if (page != null) {
            if (page.hasNonNull("monitoring_at")) monitoring = Json.text(page, "monitoring_at");
            else monitoring = last;
        }
        Instant due = null;
        if (monitoring != null) {
            due = Json.parseDate(monitoring).plusSeconds((long) WINDOW_DAYS * 86400L);
        }
        String region = regionByCounty.get(countyKey(Json.text(p, "county")));
        if (region == null) throw new IllegalStateException("Unmapped roster county: " + Json.text(p, "county"));
        ArrayNode failed = Json.MAPPER.createArrayNode();
        if (page != null) {
            for (JsonNode measureId : Json.array(page, "failed_measures")) {
                String mid = measureId.asText();
                for (JsonNode m : Json.array(page, "measures")) {
                    if (mid.equals(Json.text(m, "measure_id"))) {
                        ObjectNode f = Json.MAPPER.createObjectNode();
                        f.put("column", Json.text(m, "column"));
                        f.put("title", Json.text(m, "title"));
                        failed.add(f);
                    }
                }
            }
        }
        String currentGrade = page == null ? null : Json.text(page, "current_grade");
        String gradeBucket = currentGrade != null ? currentGrade : (last != null ? "pending" : "unassessed");
        String freshness = due == null ? "never" : !asOf.isBefore(due) ? "overdue" : "current";
        String findingBucket = last == null ? "unassessed" : failed.size() > 0 ? "flagged" : "no_recorded_failure";
        ObjectNode row = Json.MAPPER.createObjectNode();
        row.put("hospital_key", id);
        row.put("name", Json.text(p, "name"));
        row.put("county", Json.text(p, "county"));
        row.put("region", region);
        row.put("historical_grade", Json.text(p, "grade"));
        if (currentGrade != null) row.put("current_grade", currentGrade);
        else row.putNull("current_grade");
        row.put("grade_bucket", gradeBucket);
        if (last != null) row.put("last_successful_assessment_at", last);
        else row.putNull("last_successful_assessment_at");
        if (monitoring != null) row.put("monitoring_at", monitoring);
        else row.putNull("monitoring_at");
        row.put("audit_mode", page != null && Json.text(page, "audit_mode") != null
                ? Json.text(page, "audit_mode") : "scoped_reviews");
        row.put("evidence_complete", page != null && page.path("evidence_complete").asBoolean(false));
        if (due != null) row.put("next_due_at", Json.toIso(due));
        else row.putNull("next_due_at");
        row.put("freshness", freshness);
        row.put("finding_bucket", findingBucket);
        if (page != null) row.put("revision", Json.text(page, "revision"));
        else row.put("revision", "unassessed");
        row.set("failed", failed);
        return row;
    }

    /** Count each roster entry once in each independent breakdown — mirrors summarize(). */
    private ObjectNode summarize(ArrayNode rows) {
        Map<String, Integer> freshness = ordered("current", "overdue", "never");
        Map<String, Integer> historical = ordered(GRADES.toArray(String[]::new));
        Map<String, Integer> currentGrades = ordered("A", "B", "C", "D", "F", "pending", "unassessed");
        Map<String, Integer> findings = ordered("flagged", "no_recorded_failure", "unassessed");
        for (JsonNode row : rows) {
            freshness.compute(Json.text(row, "freshness"), (k, v) -> v + 1);
            historical.compute(Json.text(row, "historical_grade"), (k, v) -> v + 1);
            currentGrades.compute(Json.text(row, "grade_bucket"), (k, v) -> v + 1);
            findings.compute(Json.text(row, "finding_bucket"), (k, v) -> v + 1);
        }
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.put("total", rows.size());
        out.set("freshness", toObject(freshness));
        out.set("historical", toObject(historical));
        out.set("current_grades", toObject(currentGrades));
        out.set("findings", toObject(findings));
        return out;
    }

    private static Map<String, Integer> ordered(String... keys) {
        Map<String, Integer> map = new LinkedHashMap<>();
        for (String k : keys) map.put(k, 0);
        return map;
    }

    private static ObjectNode toObject(Map<String, Integer> counts) {
        ObjectNode out = Json.MAPPER.createObjectNode();
        counts.forEach(out::put);
        return out;
    }
}
