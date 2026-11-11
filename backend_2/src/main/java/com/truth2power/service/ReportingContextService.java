package com.truth2power.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.truth2power.config.RepoPaths;
import org.springframework.stereotype.Service;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Port of backend/reporting/context.js — the public reporting context for
 * one hospital (document languages and service-area comparison). Descriptive
 * only: it lives outside assessment findings and is never passed to the grader.
 */
@Service
public class ReportingContextService {

    private final JsonNode inventory;
    private final JsonNode context;
    private final java.util.Map<String, JsonNode> summaries;
    private final JsonNode reviews;
    private final java.util.Map<String, JsonNode> collections;

    public ReportingContextService(RepoPaths paths) {
        Path repoRoot = paths.dataDir().getParent();
        try {
            this.inventory = Json.readFile(repoRoot.resolve("docs/audit-format/wave-one-document-inventory.json"));
            this.context = Json.readFile(repoRoot.resolve("references/wave-one-reporting-context-v1.json"));
            this.summaries = new java.util.LinkedHashMap<>();
            for (String key : List.of("1002", "362")) {
                summaries.put(key, Json.readFile(repoRoot.resolve("docs/audit-format/summaries/" + key + ".json")));
            }
            this.reviews = Json.readFile(repoRoot.resolve("docs/audit-format/summaries/review.json"));
            this.collections = new java.util.LinkedHashMap<>();
            for (String key : List.of("1002", "362")) {
                collections.put(key, Json.readFile(repoRoot.resolve("docs/audit-format/posting/collections/" + key + ".json")));
            }
        } catch (Exception e) {
            throw new IllegalStateException("Reporting context reference data could not be loaded", e);
        }
    }

    private static boolean https(String url) {
        return url != null && url.startsWith("https://");
    }

    private static boolean strings(JsonNode items) {
        if (items == null || !items.isArray() || items.size() == 0) return false;
        for (JsonNode s : items) {
            if (!s.isTextual() || s.asText().isBlank()) return false;
        }
        return true;
    }

    /** Descriptive comparison only — mirrors compareCounties(). */
    public ObjectNode compareCounties(JsonNode psa) {
        JsonNode ref = psa.get("expected_reference");
        boolean ready = ref != null && !ref.isNull()
                && ref.path("independent").asBoolean(false)
                && strings(ref.get("counties"))
                && https(Json.text(ref, "url"))
                && nonBlank(Json.text(ref, "publisher"))
                && nonBlank(Json.text(ref, "locator"))
                && nonBlank(Json.text(ref, "quote"))
                && nonBlank(Json.text(ref, "applicability"));
        ObjectNode out = Json.MAPPER.createObjectNode();
        if (!ready) {
            out.put("status", "pending_review");
            out.putNull("expected_counties");
            out.putNull("reference");
            out.set("differences", Json.MAPPER.createArrayNode());
            out.put("note", "Independent county reference not established. Expected counties and correctness comparison are pending review.");
            return out;
        }
        List<JsonNode> statements = new ArrayList<>();
        for (JsonNode s : Json.array(psa, "statements")) {
            if ("counties".equals(Json.text(s, "geography_type")) && strings(s.get("reported_counties"))) {
                statements.add(s);
            }
        }
        ArrayNode differences = Json.MAPPER.createArrayNode();
        boolean mismatch = false;
        List<String> expected = new ArrayList<>();
        for (JsonNode c : ref.get("counties")) expected.add(c.asText());
        for (JsonNode s : statements) {
            List<String> reported = new ArrayList<>();
            for (JsonNode c : s.get("reported_counties")) reported.add(c.asText());
            ArrayNode missing = Json.MAPPER.createArrayNode();
            for (String c : expected) if (!reported.contains(c)) missing.add(c);
            ArrayNode additional = Json.MAPPER.createArrayNode();
            for (String c : reported) if (!expected.contains(c)) additional.add(c);
            if (missing.size() > 0 || additional.size() > 0) mismatch = true;
            ObjectNode d = Json.MAPPER.createObjectNode();
            d.put("url", Json.text(s.get("evidence"), "url"));
            d.put("language", Json.text(s, "language"));
            d.set("missing", missing);
            d.set("additional", additional);
            differences.add(d);
        }
        out.put("status", statements.isEmpty() ? "pending_review" : mismatch ? "differs_from_reference" : "matches_reference");
        ArrayNode expectedNode = Json.MAPPER.createArrayNode();
        for (String c : expected) expectedNode.add(c);
        out.set("expected_counties", expectedNode);
        out.set("reference", ref);
        out.set("differences", differences);
        out.put("note", statements.isEmpty()
                ? "The hospital has not supplied an explicit county set to compare with this reference."
                : "Reported and independently referenced counties compared for information only.");
        return out;
    }

    private static boolean nonBlank(String v) {
        return v != null && !v.isBlank();
    }

    public ObjectNode reportingContext(String hospitalKey) {
        JsonNode hospital = null;
        for (JsonNode h : Json.array(inventory, "hospitals")) {
            if (hospitalKey.equals(Json.text(h, "hospital_key"))) {
                hospital = h;
                break;
            }
        }
        JsonNode hospitals = context.get("hospitals");
        if (hospital == null || hospitals == null || !hospitals.has(hospitalKey)) return null;
        JsonNode collection = collections.get(hospitalKey);
        ArrayNode documents = Json.MAPPER.createArrayNode();
        for (JsonNode d : Json.array(hospital, "documents")) {
            JsonNode record = null;
            for (JsonNode r : Json.array(collection, "documents")) {
                String sha = Json.text(d, "sha256");
                if (sha != null) {
                    if (sha.equals(Json.text(r, "sha256"))) {
                        record = r;
                        break;
                    }
                } else if (Json.text(r, "source_url") != null
                        && Json.text(r, "source_url").endsWith("/" + Json.text(d, "filename"))) {
                    record = r;
                    break;
                }
            }
            if (record == null) throw new IllegalStateException("Document inventory and collection differ");
            boolean confirmed = Json.text(d, "sha256") != null && "saved".equals(Json.text(record, "status"));
            ObjectNode doc = Json.MAPPER.createObjectNode();
            doc.put("name", Json.text(d, "filename"));
            doc.put("role", Json.text(d, "type"));
            doc.put("language", confirmed ? Json.text(d, "language_label") : "Unknown");
            doc.put("language_status", confirmed ? "observed_in_document" : "unverified_filename_label");
            if (confirmed) {
                doc.put("note", "Language identification only; translation quality and measure review are separate.");
            } else {
                JsonNode statusNode = record.get("http_status");
                String status = statusNode != null && !statusNode.isNull() ? statusNode.asText() : null;
                doc.put("note", Json.text(d, "language_label") + "; linked document unavailable ("
                        + (status != null ? status : "retrieval failed") + ").");
            }
            String url = Json.text(record, "url");
            if (url == null) url = Json.text(record, "source_url");
            doc.put("url", url);
            if (Json.text(d, "sha256") != null) doc.put("sha256", Json.text(d, "sha256"));
            else doc.putNull("sha256");
            if (Json.text(record, "retrieved_at") != null) doc.put("retrieved_at", Json.text(record, "retrieved_at"));
            else doc.putNull("retrieved_at");
            if (confirmed) {
                ObjectNode evidence = Json.MAPPER.createObjectNode();
                evidence.put("locator", Json.text(d, "locator"));
                evidence.put("quote", Json.text(d, "quote"));
                doc.set("evidence", evidence);
            } else {
                doc.putNull("evidence");
            }
            documents.add(doc);
        }
        JsonNode summary = summaries.get(hospitalKey);
        for (JsonNode source : Json.array(summary, "snapshots")) {
            boolean present = false;
            for (JsonNode d : documents) {
                if (Json.text(d, "sha256") != null && Json.text(d, "sha256").equals(Json.text(source, "sha256"))
                        && Json.text(d, "url") != null && Json.text(d, "url").equals(Json.text(source, "url"))) {
                    present = true;
                    break;
                }
            }
            if (present) continue;
            JsonNode review = null;
            JsonNode reviewDocs = reviews.path("hospitals").path(hospitalKey).path("documents");
            for (JsonNode d : reviewDocs) {
                if (Json.text(d, "snapshot_id") != null
                        && Json.text(d, "snapshot_id").equals(Json.text(source, "snapshot_id"))) {
                    review = d;
                    break;
                }
            }
            ObjectNode doc = Json.MAPPER.createObjectNode();
            String url = Json.text(source, "url");
            doc.put("name", url.substring(url.lastIndexOf('/') + 1));
            doc.put("role", "policy_summary");
            doc.put("language", Json.text(review, "language"));
            doc.put("language_status", "observed_in_document");
            doc.put("note", "Designated summary discovered on the linked PLS page under #24. Language review is not translation certification.");
            doc.put("url", url);
            doc.put("sha256", Json.text(source, "sha256"));
            doc.put("retrieved_at", Json.text(source, "retrieved_at"));
            ObjectNode evidence = Json.MAPPER.createObjectNode();
            evidence.put("locator", Json.text(review.path("title_evidence"), "locator"));
            evidence.put("quote", Json.text(review.path("title_evidence"), "quote"));
            doc.set("evidence", evidence);
            documents.add(doc);
        }
        JsonNode psa = hospitals.get(hospitalKey);
        ObjectNode psaOut = (ObjectNode) psa.deepCopy();
        psaOut.remove("expected_reference");
        psaOut.set("comparison", compareCounties(psa));
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.put("hospital_key", hospitalKey);
        out.put("version", Json.text(context, "version"));
        out.put("reviewed_at", Json.text(context, "reviewed_at"));
        out.put("included_in_grade", false);
        out.put("scope", Json.text(context, "scope"));
        out.set("documents", documents);
        out.set("psa", psaOut);
        ArrayNode graded = Json.MAPPER.createArrayNode();
        graded.add("policy_summary.primary_service_area_described");
        graded.add("posted_materials.primary_service_area_boundaries_compliant");
        out.set("graded_checks", graded);
        return out;
    }
}
