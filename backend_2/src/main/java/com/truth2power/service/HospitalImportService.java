package com.truth2power.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.truth2power.config.RepoPaths;
import com.truth2power.model.Assessment;
import com.truth2power.model.County;
import com.truth2power.model.DatasetMeta;
import com.truth2power.model.Hospital;
import com.truth2power.model.MeasureResult;
import com.truth2power.repository.AssessmentRepository;
import com.truth2power.repository.CountyRepository;
import com.truth2power.repository.DatasetMetaRepository;
import com.truth2power.repository.HospitalRepository;
import com.truth2power.repository.MeasureResultRepository;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * One-way import of the Wave 1 baseline into TiDB (Phase 2).
 * Sources (repo files, never edited by the import):
 * data/maps/hospitals.geojson, data/maps/counties.geojson,
 * references/ny-economic-regions-v1.json, data/&lt;id&gt;-*.json,
 * rubrics/css-17-v1.json.
 *
 * Measure derivation (validated Nov 11 against all 212 hospital JSONs):
 * each of the 17 rubric measures maps to one boolean field in the hospital
 * JSON (see MEASURE_FIELDS); true means the measure is satisfied ("yes"),
 * false means it is not ("no"), missing/null means "unclear". The single
 * exception is application.maximum_fpl, which is a string in the JSON:
 * "no" means no maximum is stated ("no"), any percentage string ("400%",
 * "500%", ...) means one is stated ("yes"). Derived noncompliant counts
 * match the files' stated noncompliant_categories_count for 210 of 212
 * hospitals; the 2 exceptions (BronxCare 1164 and 1178, derived 12 vs
 * stated 13) are kept visible: both counts are stored on the assessment and
 * the mismatch is reported by the import summary instead of being silently
 * adjusted. The grade is stored as stated in the source file.
 *
 * Idempotent: re-running the import skips assessments whose
 * (hospital_id, revision) already exists; hospitals and counties are upserted.
 *
 * Profile-gated to "tidb" (or "import"): in the default profile the JPA
 * repositories do not exist (DataSource auto-config is excluded), so an
 * unconditional bean here would fail the whole app at startup. The default
 * profile must keep booting file-backed with no database at all.
 */
@Service
@Profile({"tidb", "import"})
public class HospitalImportService {

    private static final Logger log = LoggerFactory.getLogger(HospitalImportService.class);

    /** measure_id -> {section, field} in the hospital JSON. */
    static final Map<String, String[]> MEASURE_FIELDS = new LinkedHashMap<>();

    static {
        MEASURE_FIELDS.put("posted_materials.application_posted",
                new String[]{"posted_materials", "application_posted"});
        MEASURE_FIELDS.put("posted_materials.policy_summary_posted",
                new String[]{"posted_materials", "policy_summary_posted"});
        MEASURE_FIELDS.put("posted_materials.policy_statement_posted",
                new String[]{"posted_materials", "policy_statement_posted"});
        MEASURE_FIELDS.put("posted_materials.consistent_across_documents",
                new String[]{"posted_materials", "consistent_across_documents"});
        MEASURE_FIELDS.put("posted_materials.primary_service_area_boundaries_compliant",
                new String[]{"posted_materials", "primary_service_area_boundaries_compliant"});
        MEASURE_FIELDS.put("posted_materials.no_submission_time_limit",
                new String[]{"posted_materials", "no_submission_time_limit"});
        MEASURE_FIELDS.put("posted_materials.no_evidence_of_asset_checks",
                new String[]{"posted_materials", "no_evidence_of_asset_checks"});
        MEASURE_FIELDS.put("posted_materials.no_immigration_status_barrier",
                new String[]{"posted_materials", "no_immigration_status_barrier"});
        MEASURE_FIELDS.put("application.uniform_application",
                new String[]{"application", "entire_uniform_application"});
        MEASURE_FIELDS.put("application.contact_information",
                new String[]{"application", "contact_information_included"});
        MEASURE_FIELDS.put("application.income_discount_tables",
                new String[]{"application", "income_and_discount_tables_included"});
        MEASURE_FIELDS.put("application.fpl_guidelines",
                new String[]{"application", "uses_2025_fpl_guidelines"});
        MEASURE_FIELDS.put("application.maximum_fpl",
                new String[]{"application", "maximum_fpl"});
        MEASURE_FIELDS.put("application.installments_cap",
                new String[]{"application", "installments_capped_at_five_percent"});
        MEASURE_FIELDS.put("policy_summary.primary_service_area_described",
                new String[]{"policy_summary", "primary_service_area_described"});
        MEASURE_FIELDS.put("policy_summary.means_of_applying_explained",
                new String[]{"policy_summary", "means_of_applying_explained"});
        MEASURE_FIELDS.put("policy_summary.income_levels_included",
                new String[]{"policy_summary", "income_levels_included"});
    }

    private final RepoPaths paths;
    private final CountyRepository counties;
    private final HospitalRepository hospitals;
    private final AssessmentRepository assessments;
    private final MeasureResultRepository measureResults;
    private final DatasetMetaRepository datasetMeta;

    public HospitalImportService(RepoPaths paths,
                                 CountyRepository counties,
                                 HospitalRepository hospitals,
                                 AssessmentRepository assessments,
                                 MeasureResultRepository measureResults,
                                 DatasetMetaRepository datasetMeta) {
        this.paths = paths;
        this.counties = counties;
        this.hospitals = hospitals;
        this.assessments = assessments;
        this.measureResults = measureResults;
        this.datasetMeta = datasetMeta;
    }

    public record ImportSummary(int counties, int hospitals, int assessments, int measureResults,
                                List<String> countMismatches) {
    }

    @Transactional
    public ImportSummary importAll() throws IOException {
        List<String> mismatches = new ArrayList<>();

        // Counties + regions.
        JsonNode regionDoc = Json.readFile(paths.repoFile("references/ny-economic-regions-v1.json"));
        // County names differ in punctuation between the two sources
        // ("St Lawrence" in counties.geojson vs "St. Lawrence" in the
        // regions file), so keys are normalized the same way OverviewService
        // keys its map (strip "." + lowercase) — otherwise St. Lawrence
        // imports with a null region and the DB overview throws.
        Map<String, String> countyToRegion = new LinkedHashMap<>();
        JsonNode regions = regionDoc.path("regions");
        for (Map.Entry<String, JsonNode> e : Json.fields(regions)) {
            for (JsonNode county : e.getValue()) {
                countyToRegion.put(countyKey(county.asText()), e.getKey());
            }
        }
        JsonNode countiesDoc = Json.readFile(paths.mapsDir().resolve("counties.geojson"));
        int countyCount = 0;
        for (JsonNode feature : countiesDoc.path("features")) {
            String name = feature.path("properties").path("NAME").asText(null);
            if (name == null || name.isBlank()) {
                continue;
            }
            County county = counties.findById(name).orElseGet(() -> new County(name, null));
            county.setRegion(countyToRegion.get(countyKey(name)));
            counties.save(county);
            countyCount++;
        }

        // Rubric: the 17 measure ids + CSS columns (the authority for the list).
        JsonNode rubric = Json.readFile(paths.repoFile("rubrics/css-17-v1.json"));
        Map<String, String> measureColumns = new LinkedHashMap<>();
        for (JsonNode m : rubric.path("measures")) {
            measureColumns.put(m.path("measure_id").asText(), m.path("css_column").asText(null));
        }
        for (String measureId : measureColumns.keySet()) {
            if (!MEASURE_FIELDS.containsKey(measureId)) {
                throw new IllegalStateException("No JSON field mapping for rubric measure " + measureId);
            }
        }
        if (measureColumns.size() != 17) {
            throw new IllegalStateException("Expected 17 rubric measures, found " + measureColumns.size());
        }

        // Hospitals from the atlas GeoJSON. The roster key is the feature's
        // top-level "id" (a NYSDOH PFI, or a synthetic t2p-* id for the one
        // hospital with no PFI — Cohen Children's, t2p-0001). The "pfi"
        // property is absent for that hospital, so it must not be the key.
        JsonNode hospitalsDoc = Json.readFile(paths.mapsDir().resolve("hospitals.geojson"));
        // Dataset-level top level (name/attribution) so the DB-backed
        // /api/hospitals can reproduce the file's top level.
        datasetMeta.save(new DatasetMeta("hospitals.name",
                Json.text(hospitalsDoc, "name")));
        datasetMeta.save(new DatasetMeta("hospitals.attribution",
                Json.text(hospitalsDoc, "attribution")));
        Map<String, String> recordPathToId = new LinkedHashMap<>();
        int hospitalCount = 0;
        int featureIndex = 0;
        for (JsonNode feature : hospitalsDoc.path("features")) {
            JsonNode props = feature.path("properties");
            String id = feature.path("id").asText(null);
            if (id == null || id.isBlank()) {
                continue;
            }
            String recordPath = props.path("record_path").asText(null);
            if (recordPath != null) {
                recordPathToId.put(recordPath, id);
            }
            Path dataFile = recordPath != null ? paths.repoFile(recordPath) : null;
            JsonNode data = dataFile != null && Files.exists(dataFile) ? Json.readFile(dataFile) : null;

            Hospital hospital = hospitals.findById(id).orElseGet(Hospital::new);
            hospital.setId(id);
            hospital.setName(props.path("name").asText());
            hospital.setSlug(slugFromRecordPath(recordPath, id));
            // Roster order: the geojson feature order. The DB read path
            // serves /api/hospitals in this order, matching the file.
            hospital.setSortOrder(featureIndex);
            featureIndex++;
            hospital.setCounty(props.path("county").asText());
            hospital.setAddress(optText(props, "address"));
            hospital.setCity(optText(props, "city"));
            hospital.setGrade(optText(props, "grade"));
            hospital.setStars(props.path("stars").isNumber() ? props.path("stars").asInt() : null);
            hospital.setReviewMonth(optText(props, "review_month"));
            hospital.setRecordPath(recordPath);
            hospital.setAssistanceUrl(optText(props, "assistance_url"));
            hospital.setAuditUrl(optText(props, "audit_url"));
            JsonNode geometry = feature.path("geometry");
            if (geometry.path("coordinates").isArray() && geometry.path("coordinates").size() == 2) {
                hospital.setLongitude(new BigDecimal(geometry.path("coordinates").get(0).asText()));
                hospital.setLatitude(new BigDecimal(geometry.path("coordinates").get(1).asText()));
            }
            if (data != null) {
                JsonNode hospitalNode = data.path("hospital");
                hospital.setZipCode(optText(hospitalNode, "zip_code"));
                String phone = optText(data.path("application"), "contact_phone");
                hospital.setPhone("no".equals(phone) ? null : phone);
                String website = optText(data.path("hyperlinks"), "hospital_name");
                if (website == null) {
                    website = optText(data.path("hyperlinks"), "financial_assistance");
                }
                hospital.setWebsite(website);
            }
            hospital.setSourceFeatureJson(Json.stringify(feature));
            hospitals.save(hospital);
            hospitalCount++;
        }

        // Assessments + measure results from data/<id>-*.json.
        int assessmentCount = 0;
        int measureCount = 0;
        List<Path> files;
        try (Stream<Path> stream = Files.list(paths.dataDir())) {
            files = stream.filter(p -> p.getFileName().toString().endsWith(".json"))
                    .sorted()
                    .toList();
        }
        for (Path file : files) {
            String fileName = file.getFileName().toString();
            // The hospital is the roster entry whose record_path points at
            // this file — the filename prefix is not a key (Cohen's file is
            // cohen-children-s-medical-center.json, its roster id t2p-0001).
            String hospitalId = recordPathToId.get("data/" + fileName);
            if (hospitalId == null) {
                throw new IllegalStateException("No roster hospital for data file " + fileName);
            }
            byte[] bytes = Files.readAllBytes(file);
            String revision = Json.sha256Hex(bytes);
            if (assessments.findByHospitalIdAndRevision(hospitalId, revision).isPresent()) {
                assessmentCount++;
                continue;
            }
            JsonNode data = Json.MAPPER.readTree(bytes);
            JsonNode assessmentNode = data.path("assessment");

            Assessment assessment = new Assessment();
            assessment.setHospitalId(hospitalId);
            assessment.setRevision(revision);
            assessment.setGrade(optText(assessmentNode, "grade"));
            assessment.setAutomaticFail(assessmentNode.path("automatic_fail").asBoolean(false));
            Integer stated = assessmentNode.path("noncompliant_categories_count").isNumber()
                    ? assessmentNode.path("noncompliant_categories_count").asInt() : null;
            assessment.setNoncompliantCount(stated);
            String reviewMonth = Json.textOr(data.path("source"), "review_month", null);
            assessment.setAssessedAt(reviewMonth != null && reviewMonth.length() >= 7
                    ? LocalDate.of(Integer.parseInt(reviewMonth.substring(0, 4)),
                            Integer.parseInt(reviewMonth.substring(5, 7)), 1)
                    : null);
            assessment.setSourceRow(new String(bytes, StandardCharsets.UTF_8));

            int derived = 0;
            List<String[]> rows = new ArrayList<>();
            for (Map.Entry<String, String> e : measureColumns.entrySet()) {
                String measureId = e.getKey();
                String[] field = MEASURE_FIELDS.get(measureId);
                JsonNode section = data.path(field[0]);
                JsonNode value = section.path(field[1]);
                String status = deriveStatus(measureId, value);
                if ("no".equals(status)) {
                    derived++;
                }
                rows.add(new String[]{measureId, e.getValue(), status});
            }
            assessment.setNoncompliantCountDerived(derived);
            // Stars from the atlas row for this hospital, kept on the assessment too.
            hospitals.findById(hospitalId).ifPresent(h -> assessment.setStars(h.getStars()));
            assessments.save(assessment);
            for (String[] row : rows) {
                measureResults.save(new MeasureResult(assessment.getId(), row[0], row[1], row[2],
                        "data/" + fileName));
            }
            assessmentCount++;
            measureCount += rows.size();
            if (stated != null && !stated.equals(derived)) {
                mismatches.add(hospitalId + ": stated noncompliant_categories_count=" + stated
                        + " but derived from the 17 measure fields=" + derived);
            }
        }

        ImportSummary summary = new ImportSummary(countyCount, hospitalCount, assessmentCount,
                measureCount, mismatches);
        log.info("Import complete: counties={} hospitals={} assessments={} measure_results={} "
                + "count_mismatches={}", countyCount, hospitalCount, assessmentCount,
                measureCount, mismatches.size());
        for (String mismatch : mismatches) {
            log.warn("Import count mismatch: {}", mismatch);
        }
        if (countyCount != 62 || hospitalCount != 212 || assessmentCount != 212 || measureCount != 212 * 17) {
            throw new IllegalStateException("Import counts do not match the Wave 1 baseline: " + summary);
        }
        return summary;
    }

    /** One measure's status from its JSON field. Maximum FPL is a string, not a boolean. */
    static String deriveStatus(String measureId, JsonNode value) {
        if ("application.maximum_fpl".equals(measureId)) {
            if (value.isTextual()) {
                return "no".equals(value.asText()) ? "no" : "yes";
            }
            return "unclear";
        }
        if (value.isBoolean()) {
            return value.asBoolean() ? "yes" : "no";
        }
        return "unclear";
    }

    private static String optText(JsonNode node, String field) {
        if (node == null || node.isMissingNode() || !node.has(field)) {
            return null;
        }
        JsonNode value = node.path(field);
        return value.isTextual() ? value.asText() : null;
    }

    /** Same normalization OverviewService uses for county keys. */
    private static String countyKey(String name) {
        return name == null ? "" : name.replace(".", "").toLowerCase(java.util.Locale.ROOT);
    }

    private static String slugFromRecordPath(String recordPath, String id) {
        if (recordPath == null) {
            return id;
        }
        String file = recordPath.substring(recordPath.lastIndexOf('/') + 1);
        if (file.startsWith(id + "-") && file.endsWith(".json")) {
            return file.substring(id.length() + 1, file.length() - ".json".length());
        }
        return file;
    }
}
