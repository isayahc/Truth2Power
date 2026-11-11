package com.truth2power.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Port of backend/hospital-page/records.js — reads the local review records
 * under {@code .audit/live} (application-reviews, full-reviews,
 * cross-document-reviews, page-rechecks), validates and projects them into
 * display records, and groups them into latest-by-scope views.
 * Invalid artifacts are reported as unavailable, never promoted.
 */
public final class LocalRecords {

    private static final Pattern HASH32_DIR = Pattern.compile("^[a-f0-9]{32}$");
    private static final Pattern HASH32_FILE = Pattern.compile("^[a-f0-9]{32}\\.json$");
    private static final Pattern HOSPITAL_DIR = Pattern.compile("^\\d{1,8}$");
    private static final Pattern RECHECK_FILE = Pattern.compile("^[a-zA-Z0-9-]+\\.json$");
    private static final Pattern HOSPITAL_KEY = Pattern.compile("^(\\d{1,8}|t2p-\\d+)$");
    private static final Pattern SHA64 = Pattern.compile("^[a-f0-9]{64}$");
    private static final long MAX_ARTIFACT_BYTES = 20L * 1024 * 1024;

    private LocalRecords() {}

    public static String safeUrl(String value) {
        if (value == null) return null;
        try {
            java.net.URI u = new java.net.URI(value);
            if (!"https".equalsIgnoreCase(u.getScheme()) || u.getUserInfo() != null) return null;
            return u.toString();
        } catch (Exception e) {
            return null;
        }
    }

    public static byte[] readBounded(Path root, String relative) throws IOException {
        Path rootReal = root.toRealPath();
        Path actual = rootReal.resolve(relative).toRealPath();
        if (!actual.startsWith(rootReal) || actual.getNameCount() <= rootReal.getNameCount()
                || Files.size(actual) > MAX_ARTIFACT_BYTES) {
            throw new IOException("Invalid artifact path");
        }
        return Files.readAllBytes(actual);
    }

    private static List<Path> files(Path dir) throws IOException {
        if (!Files.isDirectory(dir)) return List.of();
        try (var stream = Files.list(dir)) {
            return stream.sorted().toList();
        }
    }

    /** Port of projectRecord: returns null for synthetic/demo artifacts, throws on invalid ones. */
    public static ObjectNode projectRecord(byte[] raw, String path, String kind) {
        JsonNode a;
        try {
            a = Json.MAPPER.readTree(raw);
        } catch (IOException e) {
            throw new IllegalArgumentException("Invalid assessment identity");
        }
        String hash = Json.sha256Hex(raw);
        if (a.path("synthetic").asBoolean(false) || "demo-v1".equals(Json.text(a, "rubric_version"))) return null;
        String at = a.hasNonNull("attempt") ? Json.text(a.get("attempt"), "attempted_at") : null;
        if (at == null) at = Json.text(a, "checked_at");
        JsonNode assessment = a.get("assessment");
        String completed = assessment != null && assessment.hasNonNull("completed_at")
                ? assessment.get("completed_at").asText() : Json.text(a, "checked_at");
        String hospitalKey = Json.text(a, "hospital_key");
        if (hospitalKey == null || !HOSPITAL_KEY.matcher(hospitalKey).matches() || !Json.validDate(at)) {
            throw new IllegalArgumentException("Invalid assessment identity");
        }
        List<JsonNode> findings = new ArrayList<>();
        if (assessment != null && assessment.has("findings") && assessment.get("findings").isArray()) {
            assessment.get("findings").forEach(findings::add);
        } else if (a.has("findings") && a.get("findings").isArray()) {
            a.get("findings").forEach(findings::add);
        }
        String scope = kind;
        String label = switch (kind) {
            case "posting" -> "Posted document links";
            case "summaries" -> "English and Spanish summaries";
            case "full-reviews" -> "Full posted-material review";
            case "cross-document-reviews" -> "Cross-document review (excerpt coverage)";
            default -> null;
        };
        if ("application-reviews".equals(kind)) {
            Map<String, Object> identity = ReviewIdentity.reviewIdentity(a, kind, hash);
            scope = (String) identity.get("group");
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> docs = (List<Map<String, Object>>) identity.get("documents");
            List<String> labels = new ArrayList<>();
            for (Map<String, Object> d : docs) labels.add((String) d.get("language_label"));
            String scopeLabel = Json.text(a, "scope_label");
            label = (scopeLabel != null ? scopeLabel : "Selected application") + " · "
                    + (labels.isEmpty() ? "language unknown" : String.join(", ", labels));
        }
        boolean failed = a.hasNonNull("attempt") && "failed".equals(Json.text(a.get("attempt"), "status"));
        if (!failed && (!Json.validDate(completed) || !a.has("snapshots") || !a.get("snapshots").isArray())) {
            throw new IllegalArgumentException("Incomplete assessment");
        }
        List<JsonNode> snapshots = Json.array(a, "snapshots");
        ArrayNode projected = Json.MAPPER.createArrayNode();
        for (JsonNode f : findings) {
            ObjectNode pf = Json.MAPPER.createObjectNode();
            pf.put("measure_id", Json.text(f, "measure_id"));
            pf.put("result", Json.text(f, "result"));
            String explanation = Json.text(f, "explanation");
            if (explanation == null) explanation = Json.text(f, "reason");
            if (explanation == null) explanation = "The source review did not supply an explanation.";
            pf.put("explanation", explanation);
            ArrayNode evidence = Json.MAPPER.createArrayNode();
            for (JsonNode e : Json.array(f, "evidence")) {
                JsonNode s = null;
                for (JsonNode cand : snapshots) {
                    if (Json.text(cand, "snapshot_id") != null
                            && Json.text(cand, "snapshot_id").equals(Json.text(e, "snapshot_id"))) {
                        s = cand;
                        break;
                    }
                }
                String url = s == null ? null : safeUrl(Json.text(s, "url"));
                String sha = s == null ? null : Json.text(s, "sha256");
                String retrievedAt = s == null ? null : Json.text(s, "retrieved_at");
                if (s == null || url == null || sha == null || !SHA64.matcher(sha).matches()
                        || !Json.validDate(retrievedAt)
                        || Json.text(e, "quote") == null || Json.text(e, "locator") == null) {
                    throw new IllegalArgumentException("Invalid citation");
                }
                ObjectNode ev = Json.MAPPER.createObjectNode();
                ev.put("snapshot_id", Json.text(s, "snapshot_id"));
                ev.put("sha256", sha);
                ev.put("url", url);
                ev.put("retrieved_at", retrievedAt);
                String pubUpdated = Json.text(s, "publisher_updated_at");
                if (Json.validDate(pubUpdated)) ev.put("publisher_updated_at", pubUpdated);
                else ev.putNull("publisher_updated_at");
                ev.put("locator", Json.text(e, "locator"));
                ev.put("quote", Json.text(e, "quote"));
                evidence.add(ev);
            }
            pf.set("evidence", evidence);
            projected.add(pf);
        }
        List<String> measureIds = new ArrayList<>();
        for (JsonNode f : projected) measureIds.add(Json.text(f, "measure_id"));
        boolean duplicate = new java.util.HashSet<>(measureIds).size() != measureIds.size();
        boolean invalidFinding = false;
        for (JsonNode f : projected) {
            String mid = Json.text(f, "measure_id");
            String result = Json.text(f, "result");
            if (mid == null || !List.of("yes", "no", "unclear", "n_a").contains(result)
                    || (List.of("yes", "no").contains(result) && f.get("evidence").size() == 0)) {
                invalidFinding = true;
            }
        }
        if (duplicate || invalidFinding) throw new IllegalArgumentException("Invalid finding");
        JsonNode psa = a.get("psa");
        if (psa != null && "unclear".equals(Json.text(psa, "result"))) {
            boolean hasPsaMeasure = measureIds.contains("posted_materials.primary_service_area_boundaries_compliant");
            if (!hasPsaMeasure) {
                ObjectNode pf = Json.MAPPER.createObjectNode();
                pf.put("measure_id", "posted_materials.primary_service_area_boundaries_compliant");
                pf.put("result", "unclear");
                String note = Json.text(psa, "note");
                if (note == null) note = Json.text(psa, "unresolved_question");
                if (note != null) pf.put("explanation", note);
                pf.set("evidence", Json.MAPPER.createArrayNode());
                projected.add(pf);
                measureIds.add(pf.get("measure_id").asText());
            }
        }
        int guidelineYear;
        if (a.hasNonNull("guideline_year")) {
            guidelineYear = a.get("guideline_year").asInt();
        } else {
            String basis = Json.text(a, "review_date");
            if (basis == null) basis = at;
            guidelineYear = Integer.parseInt(basis.substring(0, 4));
        }
        ObjectNode record = Json.MAPPER.createObjectNode();
        record.put("hospital_key", hospitalKey);
        record.put("record_id", hash);
        record.put("artifact_path", path.replace("\\", "/"));
        record.put("kind", kind);
        record.put("scope", scope);
        record.put("scope_label", label != null ? label : kind);
        record.put("guideline_year", guidelineYear);
        record.put("checked_at", failed ? at : completed);
        if (Json.text(a, "review_date") != null) record.put("review_date", Json.text(a, "review_date"));
        else record.putNull("review_date");
        record.put("status", failed ? "failed" : "completed");
        if (failed) record.put("error", "The recheck failed. The prior successful finding is retained.");
        else record.putNull("error");
        record.set("findings", projected);
        ArrayNode affected = Json.MAPPER.createArrayNode();
        if (a.has("affected_measures") && a.get("affected_measures").isArray()) {
            a.get("affected_measures").forEach(affected::add);
        } else {
            for (String mid : measureIds) affected.add(mid);
        }
        record.set("affected_measures", affected);
        ArrayNode landing = Json.MAPPER.createArrayNode();
        for (JsonNode s : snapshots) {
            if (!"landing_page".equals(Json.text(s, "document_type"))) continue;
            ObjectNode lp = Json.MAPPER.createObjectNode();
            lp.put("url", safeUrl(Json.text(s, "url")));
            lp.put("retrieved_at", Json.text(s, "retrieved_at"));
            String pubUpdated = Json.text(s, "publisher_updated_at");
            if (Json.validDate(pubUpdated)) lp.put("publisher_updated_at", pubUpdated);
            else lp.putNull("publisher_updated_at");
            landing.add(lp);
        }
        record.set("landing_page", landing);
        return record;
    }

    public record LocalResult(List<ObjectNode> records, List<String> unavailable) {}

    public static LocalResult localRecords(Path root) {
        List<ObjectNode> records = new ArrayList<>();
        List<String> unavailable = new ArrayList<>();
        java.util.function.BiConsumer<String, String> add = (path, kind) -> {
            try {
                ObjectNode record = projectRecord(readBounded(root, path), path, kind);
                if (record != null) records.add(record);
            } catch (Exception e) {
                unavailable.add(path.replace("\\", "/"));
            }
        };
        try {
            for (String kind : List.of("application-reviews", "full-reviews")) {
                for (Path dir : files(root.resolve(kind))) {
                    if (!Files.isDirectory(dir) || !HASH32_DIR.matcher(dir.getFileName().toString()).matches()) continue;
                    for (Path f : files(dir.resolve("results"))) {
                        if (HASH32_FILE.matcher(f.getFileName().toString()).matches()) {
                            add.accept(kind + "/" + dir.getFileName() + "/results/" + f.getFileName(), kind);
                        }
                    }
                }
            }
            for (Path dir : files(root.resolve("cross-document-reviews"))) {
                if (!Files.isDirectory(dir) || !HOSPITAL_DIR.matcher(dir.getFileName().toString()).matches()) continue;
                for (Path f : files(dir)) {
                    if (HASH32_FILE.matcher(f.getFileName().toString()).matches()) {
                        add.accept("cross-document-reviews/" + dir.getFileName() + "/" + f.getFileName(),
                                "cross-document-reviews");
                    }
                }
            }
            for (Path f : files(root.resolve("page-rechecks"))) {
                String name = f.getFileName().toString();
                if (!RECHECK_FILE.matcher(name).matches()) continue;
                try {
                    JsonNode a = Json.MAPPER.readTree(readBounded(root, "page-rechecks/" + name));
                    boolean ok = !a.path("synthetic").asBoolean(false)
                            && "failed".equals(Json.text(a, "status"))
                            && Json.text(a, "hospital_key") != null
                            && HOSPITAL_KEY.matcher(Json.text(a, "hospital_key")).matches()
                            && Json.validDate(Json.text(a, "checked_at"))
                            && Json.text(a, "scope") != null
                            && a.hasNonNull("guideline_year") && a.get("guideline_year").isIntegralNumber()
                            && a.has("affected_measures") && a.get("affected_measures").isArray()
                            && Json.array(a, "affected_measures").stream().allMatch(n -> n.isTextual());
                    if (!ok) throw new IllegalArgumentException("Invalid recheck");
                    ObjectNode rec = (ObjectNode) a.deepCopy();
                    rec.set("findings", Json.MAPPER.createArrayNode());
                    rec.put("record_id", Json.sha256Hex(Json.stringify(a)));
                    rec.put("error", "The recheck failed. The prior successful finding is retained.");
                    records.add(rec);
                } catch (Exception e) {
                    unavailable.add("page-rechecks/" + name);
                }
            }
        } catch (IOException e) {
            throw new IllegalStateException("Local records could not be read", e);
        }
        return new LocalResult(records, unavailable);
    }

    /** Port of latestByScope: group records by hospital/year/scope/measure, newest first. */
    public static List<ObjectNode> latestByScope(List<ObjectNode> records) {
        Map<String, List<ObjectNode>> groups = new LinkedHashMap<>();
        for (ObjectNode r : records) {
            List<String> ids = new ArrayList<>();
            if ("failed".equals(Json.text(r, "status"))) {
                for (JsonNode m : Json.array(r, "affected_measures")) ids.add(m.asText());
            } else {
                for (JsonNode f : Json.array(r, "findings")) ids.add(Json.text(f, "measure_id"));
            }
            for (String id : ids) {
                String scope = List.of("full-reviews", "cross-document-reviews").contains(Json.text(r, "kind"))
                        ? "posted-materials" : Json.text(r, "scope");
                String key = Json.stringify(List.of(Json.text(r, "hospital_key"), r.get("guideline_year").asInt(), scope, id));
                ObjectNode version = r.deepCopy();
                version.put("scope", scope);
                JsonNode finding = null;
                for (JsonNode f : Json.array(r, "findings")) {
                    if (id.equals(Json.text(f, "measure_id"))) {
                        finding = f;
                        break;
                    }
                }
                if (finding != null) version.set("finding", finding);
                else version.putNull("finding");
                version.put("measure_id", id);
                groups.computeIfAbsent(key, k -> new ArrayList<>()).add(version);
            }
        }
        List<ObjectNode> out = new ArrayList<>();
        for (List<ObjectNode> versions : groups.values()) {
            versions.sort((x, y) -> {
                int byDate = Json.parseDate(Json.text(y, "checked_at")).compareTo(Json.parseDate(Json.text(x, "checked_at")));
                if (byDate != 0) return byDate;
                return Json.text(x, "record_id").compareTo(Json.text(y, "record_id"));
            });
            ObjectNode group = Json.MAPPER.createObjectNode();
            group.set("latest", versions.get(0));
            ObjectNode success = null;
            for (ObjectNode v : versions) {
                if ("completed".equals(Json.text(v, "status"))) {
                    success = v;
                    break;
                }
            }
            if (success != null) group.set("success", success);
            else group.putNull("success");
            ArrayNode failures = Json.MAPPER.createArrayNode();
            for (ObjectNode v : versions) {
                if (!"failed".equals(Json.text(v, "status"))) continue;
                if (success == null || !Json.parseDate(Json.text(v, "checked_at"))
                        .isBefore(Json.parseDate(Json.text(success, "checked_at")))) {
                    failures.add(v);
                }
            }
            group.set("failures", failures);
            out.add(group);
        }
        return out;
    }
}
