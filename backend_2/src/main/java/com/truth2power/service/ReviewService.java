package com.truth2power.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.truth2power.config.RepoPaths;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

/**
 * Port of backend/review/service.js — the local public-document review inbox.
 * Review items are derived from audit result files under {@code .audit/live/}
 * (full-reviews / application-reviews) plus pipeline publications from
 * {@code .audit/audit.sqlite}; decisions are append-only JSON files in
 * {@code .audit/live/review-inbox-decisions/}. There is no create route:
 * items exist because a result file exists. Same-origin POST protection lives
 * in ReviewPostGuardFilter (Layer A) and ReviewController (Layer B).
 */
@Service
public class ReviewService {

    /** Error carrying an HTTP status, like Node's fail(status, message). */
    public static class ReviewException extends RuntimeException {
        private final int status;

        public ReviewException(int status, String message) {
            super(message);
            this.status = status;
        }

        public int getStatus() {
            return status;
        }
    }

    public record SourceResult(byte[] body, String contentType, String contentDisposition) {
    }

    private static final Pattern HEX32 = Pattern.compile("^[a-f0-9]{32}$");
    private static final Pattern HEX32_JSON = Pattern.compile("^[a-f0-9]{32}\\.json$");
    private static final Pattern HEX64 = Pattern.compile("^[a-f0-9]{64}$");
    private static final Pattern DECISION_FILE = Pattern.compile("^[a-f0-9-]{36}\\.json$");
    private static final Pattern HOSPITAL_KEY = Pattern.compile("^(?:\\d{1,8}|t2p-\\d+)$");
    private static final Pattern ARTIFACT_PATH = Pattern.compile("^snapshots/[a-f0-9]{64}\\.(pdf|html|docx|json)$");
    private static final Pattern PAGE_LOCATOR = Pattern.compile("^page (\\d+)$");

    private static final Map<String, String> HARDCODED_TITLES = new LinkedHashMap<>();

    static {
        HARDCODED_TITLES.put("posted_materials.no_submission_time_limit", "Application deadlines");
        HARDCODED_TITLES.put("posted_materials.no_evidence_of_asset_checks", "Asset eligibility checks");
        HARDCODED_TITLES.put("posted_materials.no_immigration_status_barrier", "Immigration eligibility");
        HARDCODED_TITLES.put("posted_materials.primary_service_area_boundaries_compliant", "Service-area rule");
        HARDCODED_TITLES.put("application.uniform_application", "Entire Uniform Application");
        HARDCODED_TITLES.put("application.contact_information", "Application contact information");
        HARDCODED_TITLES.put("application.income_discount_tables", "Income and discount tables");
        HARDCODED_TITLES.put("application.fpl_guidelines", "Application FPL year and amounts");
        HARDCODED_TITLES.put("application.maximum_fpl", "Application coverage through 400% FPL");
        HARDCODED_TITLES.put("application.installments_cap", "Monthly installment cap");
    }

    private final Path root;
    private final Path auditDir;
    private final Map<String, String> names = new HashMap<>();
    private final Map<String, String> titles = new LinkedHashMap<>(HARDCODED_TITLES);

    public ReviewService(RepoPaths paths) throws IOException {
        this.root = paths.auditLiveDir();
        this.auditDir = paths.auditDir();
        Path geojson = paths.mapsDir().resolve("hospitals.geojson");
        if (Files.exists(geojson)) {
            JsonNode doc = Json.readFile(geojson);
            for (JsonNode feature : doc.path("features")) {
                String id = Json.text(feature, "id");
                String name = Json.text(feature.path("properties"), "name");
                if (id != null && name != null) {
                    names.put(id, name);
                }
            }
        }
        Path rubric = paths.repoFile("rubrics/css-17-v1.json");
        if (Files.exists(rubric)) {
            JsonNode doc = Json.readFile(rubric);
            for (JsonNode measure : doc.path("measures")) {
                String id = Json.text(measure, "measure_id");
                String title = Json.text(measure, "title");
                if (id != null && title != null) {
                    titles.putIfAbsent(id, title);
                }
            }
        }
    }

    private static ReviewException fail(int status, String message) {
        return new ReviewException(status, message);
    }

    private static List<Path> files(Path dir) throws IOException {
        if (!Files.isDirectory(dir)) {
            return List.of();
        }
        try (var stream = Files.list(dir)) {
            return stream.sorted().toList();
        }
    }

    /** One draft version: a result file (or pipeline envelope) with its identity. */
    private record Draft(ObjectNode result, String hash, Map<String, Object> identity, String namespace) {
    }

    private record DraftScan(Map<String, List<Draft>> groups, int unavailable) {
    }

    private DraftScan drafts() {
        Map<String, List<Draft>> groups = new LinkedHashMap<>();
        int unavailable = 0;
        for (String namespace : List.of("full-reviews", "application-reviews")) {
            Path nsDir = root.resolve(namespace);
            List<Path> reviews;
            try {
                reviews = files(nsDir);
            } catch (IOException e) {
                throw new IllegalStateException("Review drafts could not be read", e);
            }
            for (Path reviewDir : reviews) {
                String review = reviewDir.getFileName().toString();
                if (!HEX32.matcher(review).matches() || !Files.isDirectory(reviewDir)) {
                    continue;
                }
                List<Path> resultFiles;
                try {
                    resultFiles = files(reviewDir.resolve("results"));
                } catch (IOException e) {
                    throw new IllegalStateException("Review drafts could not be read", e);
                }
                for (Path file : resultFiles) {
                    String filename = file.getFileName().toString();
                    if (!HEX32_JSON.matcher(filename).matches()) {
                        continue;
                    }
                    try {
                        byte[] raw = LocalRecords.readBounded(root,
                                namespace + "/" + review + "/results/" + filename);
                        JsonNode result = Json.MAPPER.readTree(raw);
                        if (!review.equals(Json.text(result, "review_id"))
                                || !filename.substring(0, 32).equals(Json.text(result, "result_id"))
                                || !HOSPITAL_KEY.matcher(String.valueOf(Json.text(result, "hospital_key"))).matches()
                                || !Json.validDate(Json.text(result, "checked_at"))
                                || !result.path("findings").isArray()
                                || !result.path("snapshots").isArray()
                                || !result.path("coverage").isArray()) {
                            throw new IllegalArgumentException("Invalid result");
                        }
                        String hash = Json.sha256Hex(raw);
                        Map<String, Object> identity = ReviewIdentity.reviewIdentity(result, namespace, hash);
                        String group = (String) identity.get("group");
                        groups.computeIfAbsent(group, k -> new ArrayList<>()).add(
                                new Draft((ObjectNode) result, hash, identity, namespace));
                    } catch (Exception e) {
                        unavailable++;
                    }
                }
            }
        }
        for (ObjectNode bundle : PipelineViews.pipelineBundles(auditDir, root)) {
            ObjectNode result = PipelineViews.reviewEnvelope(bundle);
            String hash = Json.sha256Hex(Json.stringify(result));
            JsonNode input = bundle.get("input");
            String group = "pipeline:" + Json.text(input, "hospital_key") + ":"
                    + input.get("guideline_year").asInt() + ":"
                    + input.path("synthetic").asBoolean(false);
            List<Map<String, Object>> documents = new ArrayList<>();
            for (JsonNode s : Json.array(input, "sources")) {
                Map<String, Object> doc = new LinkedHashMap<>();
                doc.put("source_id", Json.text(s, "source_id"));
                doc.put("role", Json.text(s, "role"));
                doc.put("language", Json.text(s, "language"));
                JsonNode snapshot = s.get("snapshot");
                doc.put("snapshot_sha256", snapshot == null ? null : Json.text(snapshot, "sha256"));
                String sourceId = Json.text(s, "source_id");
                doc.put("name", sourceId == null ? null : sourceId.substring(sourceId.lastIndexOf('/') + 1));
                documents.add(doc);
            }
            Map<String, Object> identity = new LinkedHashMap<>();
            identity.put("group", group);
            identity.put("identity_status", "declared");
            identity.put("documents", documents);
            groups.computeIfAbsent(group, k -> new ArrayList<>()).add(
                    new Draft(result, hash, identity, "pipeline"));
        }
        for (List<Draft> versions : groups.values()) {
            versions.sort((a, b) -> {
                int byJob = 0;
                if ("pipeline".equals(a.namespace()) && "pipeline".equals(b.namespace())) {
                    byJob = Long.compare(b.result().path("publication_job").asLong(0),
                            a.result().path("publication_job").asLong(0));
                }
                if (byJob != 0) {
                    return byJob;
                }
                int byChecked = Json.parseDate(Json.text(b.result(), "checked_at"))
                        .compareTo(Json.parseDate(Json.text(a.result(), "checked_at")));
                if (byChecked != 0) {
                    return byChecked;
                }
                int byResultId = Json.text(b.result(), "result_id")
                        .compareTo(Json.text(a.result(), "result_id"));
                if (byResultId != 0) {
                    return byResultId;
                }
                return b.hash().compareTo(a.hash());
            });
        }
        return new DraftScan(groups, unavailable);
    }

    private List<ObjectNode> decisions() throws IOException {
        Path dir = root.resolve("review-inbox-decisions");
        List<ObjectNode> out = new ArrayList<>();
        for (Path file : files(dir)) {
            String name = file.getFileName().toString();
            if (!DECISION_FILE.matcher(name).matches()) {
                continue;
            }
            byte[] raw = LocalRecords.readBounded(root, "review-inbox-decisions/" + name);
            out.add((ObjectNode) Json.MAPPER.readTree(raw));
        }
        out.sort(Comparator.comparingInt(d -> d.path("sequence").asInt(0)));
        return out;
    }

    private record ItemScan(List<ObjectNode> rows, int unavailable) {
    }

    private ItemScan items(boolean includeHistory) throws IOException {
        DraftScan scan = drafts();
        List<ObjectNode> saved = decisions();
        List<ObjectNode> rows = new ArrayList<>();
        for (List<Draft> versions : scan.groups().values()) {
            List<Draft> records = includeHistory ? versions : versions.subList(0, 1);
            for (Draft record : records) {
                ObjectNode result = record.result();
                List<JsonNode> findings = new ArrayList<>(Json.array(result, "findings"));
                JsonNode psa = result.get("psa");
                if (psa != null && "unclear".equals(Json.text(psa, "result"))
                        && findings.stream().noneMatch(f -> "posted_materials.primary_service_area_boundaries_compliant"
                                .equals(Json.text(f, "measure_id")))) {
                    ObjectNode extra = Json.MAPPER.createObjectNode();
                    extra.put("measure_id", "posted_materials.primary_service_area_boundaries_compliant");
                    extra.put("result", "unclear");
                    extra.put("explanation", Json.text(psa, "note") != null ? Json.text(psa, "note")
                            : "The applicable service-area rule needs review.");
                    extra.put("expected", "An approved, cited service-area boundary rule and applicable hospital boundaries.");
                    ArrayNode questions = Json.MAPPER.createArrayNode();
                    questions.add(Json.text(psa, "unresolved_question") != null
                            ? Json.text(psa, "unresolved_question") : "Which approved service-area rule applies?");
                    extra.set("unresolved_questions", questions);
                    extra.put("authority_url", LocalRecords.safeUrl(Json.text(psa, "authority")));
                    extra.set("evidence", Json.MAPPER.createArrayNode());
                    findings.add(extra);
                }
                for (JsonNode finding : findings) {
                    String measureId = Json.text(finding, "measure_id");
                    String draftResult = Json.text(finding, "result");
                    if (!titles.containsKey(measureId)
                            || !List.of("yes", "no", "unclear", "n_a").contains(draftResult)) {
                        continue;
                    }
                    String hash = record.hash();
                    String id = Json.sha256Hex(hash + ":" + measureId);
                    List<ObjectNode> history = new ArrayList<>();
                    for (ObjectNode d : saved) {
                        if (id.equals(Json.text(d, "item_id"))
                                && Json.text(result, "result_id").equals(Json.text(d, "result_id"))
                                && hash.equals(Json.text(d, "result_sha256"))
                                && Json.text(result, "hospital_key").equals(Json.text(d, "hospital_key"))
                                && measureId.equals(Json.text(d, "measure_id"))) {
                            history.add(d);
                        }
                    }
                    ObjectNode last = history.isEmpty() ? null : history.get(history.size() - 1);
                    String status = last != null && ("confirm".equals(Json.text(last, "action"))
                            || "correct".equals(Json.text(last, "action"))) ? "resolved"
                            : last != null ? "needs_information" : "pending";
                    ArrayNode versionsNode = Json.MAPPER.createArrayNode();
                    for (Draft v : versions) {
                        ObjectNode vn = Json.MAPPER.createObjectNode();
                        vn.set("result", v.result());
                        vn.put("hash", v.hash());
                        vn.set("identity", toNode(v.identity()));
                        vn.put("namespace", v.namespace());
                        versionsNode.add(vn);
                    }
                    ObjectNode row = Json.MAPPER.createObjectNode();
                    row.put("id", id);
                    row.put("hospital_key", Json.text(result, "hospital_key"));
                    row.put("hospital_name", names.getOrDefault(Json.text(result, "hospital_key"),
                            "Hospital " + Json.text(result, "hospital_key")));
                    row.put("measure_id", measureId);
                    row.put("title", titles.get(measureId));
                    row.put("flagged_at", Json.text(result, "checked_at"));
                    row.put("scope_label", Json.text(result, "scope_label") != null
                            ? Json.text(result, "scope_label") : "Posted-material review");
                    if (result.hasNonNull("guideline_year")) {
                        row.put("guideline_year", result.get("guideline_year").asInt());
                    } else {
                        row.putNull("guideline_year");
                    }
                    row.put("result_id", Json.text(result, "result_id"));
                    row.put("result_sha256", hash);
                    row.put("status", status);
                    row.put("draft_result", draftResult);
                    if ("resolved".equals(status)) {
                        row.put("reviewed_result", Json.text(last, "result"));
                    } else {
                        row.putNull("reviewed_result");
                    }
                    row.put("revision", history.size());
                    JsonNode questions = finding.get("unresolved_questions");
                    if (questions != null && questions.isArray() && questions.size() > 0) {
                        List<String> parts = new ArrayList<>();
                        questions.forEach(q -> parts.add(q.asText()));
                        row.put("question", String.join(" ", parts));
                    } else if ("unclear".equals(draftResult)) {
                        row.put("question", "What evidence is needed to resolve this finding?");
                    } else {
                        row.put("question", "Does the cited evidence support this draft finding?");
                    }
                    row.put("namespace", record.namespace());
                    row.put("logical_review_id", (String) record.identity().get("group"));
                    row.put("identity_status", (String) record.identity().get("identity_status"));
                    if (record.identity().get("identity_warning") != null) {
                        row.put("identity_warning", (String) record.identity().get("identity_warning"));
                    }
                    row.set("documents", toNode(record.identity().get("documents")));
                    row.put("is_current", record == versions.get(0));
                    row.put("version_count", versions.size());
                    row.set("versions", versionsNode);
                    row.set("finding", finding);
                    row.set("result", result);
                    row.set("history", toArrayNode(history));
                    rows.add(row);
                }
            }
        }
        return new ItemScan(rows, scan.unavailable());
    }

    private ObjectNode get(String id, boolean currentOnly) throws IOException {
        if (id == null || !HEX64.matcher(id).matches()) {
            throw fail(404, "Review item not found.");
        }
        ObjectNode row = items(!currentOnly).rows().stream()
                .filter(r -> id.equals(Json.text(r, "id"))).findFirst().orElse(null);
        if (row == null) {
            throw fail(404, "Review item no longer current. Refresh the inbox.");
        }
        return row;
    }

    /** The public summary: the row minus finding, result, history, versions. */
    private static ObjectNode summary(ObjectNode row) {
        ObjectNode out = row.deepCopy();
        out.remove("finding");
        out.remove("result");
        out.remove("history");
        out.remove("versions");
        return out;
    }

    private static ObjectNode sourceMetadata(ObjectNode row, JsonNode citation) {
        ObjectNode out = citation.deepCopy();
        JsonNode snapshots = row.path("result").path("snapshots");
        JsonNode source = null;
        for (JsonNode s : snapshots) {
            if (Json.text(s, "snapshot_id") != null
                    && Json.text(s, "snapshot_id").equals(Json.text(citation, "snapshot_id"))) {
                source = s;
                break;
            }
        }
        if (source == null) {
            out.put("unavailable", true);
            return out;
        }
        String locator = Json.text(citation, "locator");
        String page = null;
        if (locator != null) {
            var m = PAGE_LOCATOR.matcher(locator);
            if (m.matches()) {
                page = m.group(1);
            }
        }
        String url = Json.text(source, "url");
        String document = Json.text(source, "display_name");
        if (document == null && url != null) {
            document = url.substring(url.lastIndexOf('/') + 1);
        }
        if (document == null) {
            document = Json.text(source, "document_type");
        }
        out.put("document", document);
        String safe = LocalRecords.safeUrl(url);
        if (safe != null) {
            out.put("url", safe);
        } else {
            out.putNull("url");
        }
        out.put("retrieved_at", Json.text(source, "retrieved_at"));
        out.put("saved_url", "/api/reviews/" + Json.text(row, "id") + "/sources/"
                + Json.text(source, "snapshot_id") + (page != null ? "#page=" + page : ""));
        return out;
    }

    private record VerifiedSource(ObjectNode source, byte[] raw) {
    }

    private VerifiedSource verifiedSource(ObjectNode row, String snapshotId) throws IOException {
        JsonNode source = null;
        for (JsonNode s : row.path("result").path("snapshots")) {
            if (Json.text(s, "snapshot_id") != null
                    && Json.text(s, "snapshot_id").equals(snapshotId)) {
                source = s;
                break;
            }
        }
        if (source == null || snapshotId == null || !HEX64.matcher(snapshotId).matches()
                || Json.text(source, "sha256") == null || !HEX64.matcher(Json.text(source, "sha256")).matches()
                || Json.text(source, "artifact_path") == null
                || !ARTIFACT_PATH.matcher(Json.text(source, "artifact_path")).matches()) {
            throw fail(404, "Saved source not found.");
        }
        byte[] raw;
        try {
            raw = LocalRecords.readBounded(root, Json.text(source, "artifact_path"));
        } catch (IOException e) {
            throw fail(404, "Saved source unavailable.");
        }
        if (!Json.sha256Hex(raw).equals(Json.text(source, "sha256"))) {
            throw fail(422, "Saved source failed integrity verification.");
        }
        return new VerifiedSource((ObjectNode) source, raw);
    }

    private static JsonNode toNode(Object value) {
        if (value == null) {
            return Json.MAPPER.nullNode();
        }
        if (value instanceof JsonNode node) {
            return node;
        }
        if (value instanceof Map<?, ?> map) {
            ObjectNode out = Json.MAPPER.createObjectNode();
            for (Map.Entry<?, ?> e : map.entrySet()) {
                out.set(String.valueOf(e.getKey()), toNode(e.getValue()));
            }
            return out;
        }
        if (value instanceof List<?> list) {
            ArrayNode out = Json.MAPPER.createArrayNode();
            for (Object item : list) {
                out.add(toNode(item));
            }
            return out;
        }
        if (value instanceof String s) {
            return Json.MAPPER.getNodeFactory().textNode(s);
        }
        if (value instanceof Number n) {
            return Json.MAPPER.getNodeFactory().numberNode(n.longValue());
        }
        if (value instanceof Boolean b) {
            return Json.MAPPER.getNodeFactory().booleanNode(b);
        }
        return Json.MAPPER.getNodeFactory().textNode(String.valueOf(value));
    }

    private static ArrayNode toArrayNode(List<ObjectNode> nodes) {
        ArrayNode out = Json.MAPPER.createArrayNode();
        nodes.forEach(out::add);
        return out;
    }

    public ObjectNode list(Map<String, String> filters) throws IOException {
        ItemScan scan = items(false);
        List<ObjectNode> rows = new ArrayList<>();
        for (ObjectNode r : scan.rows()) {
            if (filters.get("hospital_key") != null
                    && !filters.get("hospital_key").equals(Json.text(r, "hospital_key"))) {
                continue;
            }
            if (filters.get("namespace") != null
                    && !filters.get("namespace").equals(Json.text(r, "namespace"))) {
                continue;
            }
            String sourceId = filters.get("source_id");
            String role = filters.get("role");
            String language = filters.get("language");
            if (sourceId != null || role != null || language != null) {
                boolean matches = false;
                for (JsonNode d : r.path("documents")) {
                    if ((sourceId == null || sourceId.equals(Json.text(d, "source_id")))
                            && (role == null || role.equals(Json.text(d, "role")))
                            && (language == null || language.equals(Json.text(d, "language")))) {
                        matches = true;
                        break;
                    }
                }
                if (!matches) {
                    continue;
                }
            }
            rows.add(r);
        }
        ArrayNode itemsNode = Json.MAPPER.createArrayNode();
        rows.forEach(r -> itemsNode.add(summary(r)));
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.set("items", itemsNode);
        out.put("pending", (int) rows.stream().filter(r -> !"resolved".equals(Json.text(r, "status"))).count());
        out.put("unavailable", scan.unavailable());
        return out;
    }

    public ObjectNode detail(String id) throws IOException {
        ObjectNode row = get(id, false);
        ObjectNode out = summary(row);
        ArrayNode documentVersions = Json.MAPPER.createArrayNode();
        for (JsonNode version : row.path("versions")) {
            ObjectNode versionResult = (ObjectNode) version.path("result");
            String versionHash = Json.text(version, "hash");
            ObjectNode dv = Json.MAPPER.createObjectNode();
            dv.put("result_id", Json.text(versionResult, "result_id"));
            dv.put("checked_at", Json.text(versionResult, "checked_at"));
            dv.put("result_sha256", versionHash);
            dv.set("documents", version.path("identity").path("documents"));
            boolean hasFinding = false;
            for (JsonNode f : versionResult.path("findings")) {
                if (Json.text(row, "measure_id").equals(Json.text(f, "measure_id"))) {
                    hasFinding = true;
                    break;
                }
            }
            JsonNode psa = versionResult.get("psa");
            if (!hasFinding && psa != null && "unclear".equals(Json.text(psa, "result"))
                    && "posted_materials.primary_service_area_boundaries_compliant"
                            .equals(Json.text(row, "measure_id"))) {
                hasFinding = true;
            }
            dv.put("item_id", hasFinding ? Json.sha256Hex(versionHash + ":" + Json.text(row, "measure_id")) : null);
            documentVersions.add(dv);
        }
        out.set("document_versions", documentVersions);
        JsonNode finding = row.path("finding");
        out.put("explanation", Json.text(finding, "explanation"));
        out.set("expected", finding.has("expected") ? finding.get("expected") : Json.MAPPER.nullNode());
        out.set("observed", finding.has("observed") ? finding.get("observed") : Json.MAPPER.nullNode());
        String authorityUrl = Json.text(finding, "authority_url");
        if (authorityUrl == null && finding.has("expected") && finding.path("expected").isObject()) {
            authorityUrl = LocalRecords.safeUrl(Json.text(finding.path("expected"), "authority_url"));
        }
        out.put("authority_url", authorityUrl);
        ArrayNode otherVersions = Json.MAPPER.createArrayNode();
        for (JsonNode url : row.path("result").path("other_application_versions_not_assessed")) {
            String safe = LocalRecords.safeUrl(url.asText(null));
            if (safe != null) {
                otherVersions.add(safe);
            }
        }
        out.set("other_application_versions_not_assessed", otherVersions);
        out.set("extraction_details", row.path("result").has("extraction_details")
                ? row.path("result").get("extraction_details") : Json.MAPPER.nullNode());
        if ("application.uniform_application".equals(Json.text(row, "measure_id"))
                && row.path("result").hasNonNull("template_comparison")) {
            ObjectNode tc = row.path("result").path("template_comparison").deepCopy();
            tc.put("reference_url", LocalRecords.safeUrl(Json.text(tc, "reference_url")));
            JsonNode reference = row.path("result").path("reference");
            tc.put("numeric_authority_url", LocalRecords.safeUrl(Json.text(reference, "authority_url")));
            tc.put("numeric_reference_version", Json.text(row.path("result"), "reference_version"));
            JsonNode wholeForm = tc.get("whole_form_review");
            if (wholeForm != null && wholeForm.isObject()) {
                ObjectNode wf = (ObjectNode) wholeForm;
                JsonNode authority = wf.get("authority");
                if (authority != null && authority.isObject()) {
                    ObjectNode auth = (ObjectNode) authority;
                    auth.put("url", LocalRecords.safeUrl(Json.text(auth, "url")));
                }
                JsonNode renders = wf.get("renders");
                if (renders != null && renders.isObject()) {
                    ObjectNode newRenders = Json.MAPPER.createObjectNode();
                    for (Map.Entry<String, JsonNode> e : Json.fields(renders)) {
                        ObjectNode render = e.getValue().deepCopy();
                        render.put("saved_url", sourceMetadata(row, e.getValue()).path("saved_url").asText(null));
                        newRenders.set(e.getKey(), render);
                    }
                    wf.set("renders", newRenders);
                }
            }
            ArrayNode observations = Json.MAPPER.createArrayNode();
            for (JsonNode o : tc.path("observations")) {
                ObjectNode no = o.deepCopy();
                ArrayNode evidence = Json.MAPPER.createArrayNode();
                for (JsonNode c : o.path("evidence")) {
                    evidence.add(sourceMetadata(row, c));
                }
                no.set("evidence", evidence);
                observations.add(no);
            }
            tc.set("observations", observations);
            out.set("template_comparison", tc);
        } else {
            out.putNull("template_comparison");
        }
        ArrayNode evidence = Json.MAPPER.createArrayNode();
        for (JsonNode c : finding.path("evidence")) {
            evidence.add(sourceMetadata(row, c));
        }
        out.set("evidence", evidence);
        ArrayNode gaps = Json.MAPPER.createArrayNode();
        for (JsonNode g : row.path("result").path("gaps")) {
            ObjectNode ng = Json.MAPPER.createObjectNode();
            ng.put("reason", Json.text(g, "reason"));
            ng.put("detail", Json.text(g, "detail"));
            ng.put("url", LocalRecords.safeUrl(Json.text(g, "url")));
            gaps.add(ng);
        }
        out.set("gaps", gaps);
        ArrayNode coverage = Json.MAPPER.createArrayNode();
        for (JsonNode c : row.path("result").path("coverage")) {
            ObjectNode nc = Json.MAPPER.createObjectNode();
            nc.put("source_id", Json.text(c, "source_id"));
            nc.put("language", Json.text(c, "language"));
            nc.put("status", Json.text(c, "status"));
            nc.put("total_pages", c.has("total_pages") ? c.get("total_pages").asInt() : null);
            JsonNode reviewed = c.get("reviewed_pages");
            nc.put("reviewed_pages", reviewed != null && reviewed.isArray() ? reviewed.size() : 0);
            String locatorUnit = Json.text(c, "locator_unit");
            if (locatorUnit == null) {
                boolean isDocx = false;
                for (JsonNode s : row.path("result").path("snapshots")) {
                    if (Json.text(s, "url") != null && Json.text(s, "url").equals(Json.text(c, "url"))
                            && Json.text(s, "artifact_path") != null
                            && Json.text(s, "artifact_path").endsWith(".docx")) {
                        isDocx = true;
                        break;
                    }
                }
                locatorUnit = isDocx ? "DOCX parts (pagination unverified)" : "pages";
            }
            nc.put("locator_unit", locatorUnit);
            nc.put("url", LocalRecords.safeUrl(Json.text(c, "url")));
            nc.put("notes", Json.text(c, "notes"));
            if (Json.text(c, "snapshot_id") != null) {
                nc.put("saved_url", sourceMetadata(row, c).path("saved_url").asText(null));
            } else {
                String savedUrl = null;
                for (JsonNode s : row.path("result").path("snapshots")) {
                    if (Json.text(s, "url") != null && Json.text(s, "url").equals(Json.text(c, "url"))) {
                        savedUrl = "/api/reviews/" + Json.text(row, "id") + "/sources/"
                                + Json.text(s, "snapshot_id");
                        break;
                    }
                }
                nc.put("saved_url", savedUrl);
            }
            coverage.add(nc);
        }
        out.set("coverage", coverage);
        out.set("history", row.path("history"));
        ArrayNode observations = Json.MAPPER.createArrayNode();
        for (JsonNode s : row.path("result").path("source_reviews")) {
            JsonNode review = s.path("review");
            for (JsonNode o : review.path("observations")) {
                if (!Json.text(row, "measure_id").equals(Json.text(o, "measure_id"))) {
                    continue;
                }
                ObjectNode no = Json.MAPPER.createObjectNode();
                no.put("source_id", Json.text(s, "source_id"));
                no.put("position", Json.text(o, "position"));
                no.put("context", Json.text(o, "context"));
                no.put("explanation", Json.text(o, "explanation"));
                ArrayNode ev = Json.MAPPER.createArrayNode();
                for (JsonNode c : o.path("evidence")) {
                    ev.add(sourceMetadata(row, c));
                }
                no.set("evidence", ev);
                observations.add(no);
            }
        }
        out.set("observations", observations);
        return out;
    }

    /**
     * Records a decision. Synchronized: the read/check/append must not race
     * another decision for the same revision in this process (Node comment).
     */
    public synchronized ObjectNode decide(String id, ObjectNode input) throws IOException {
        ObjectNode row = get(id, true);
        String action = input == null ? null : Json.text(input, "action");
        JsonNode revisionNode = input == null ? null : input.get("revision");
        String notes = input == null ? null : Json.text(input, "notes");
        String reviewerRole = input == null ? null : Json.text(input, "reviewer_role");
        if (!List.of("confirm", "correct", "request_information").contains(action)
                || revisionNode == null || !revisionNode.isIntegralNumber()
                || notes == null || notes.isBlank() || notes.length() > 2000
                || reviewerRole == null || reviewerRole.isBlank() || reviewerRole.length() > 100) {
            throw fail(400, "Provide an action, reviewer role and reason.");
        }
        int revision = revisionNode.asInt();
        if (revision != row.path("revision").asInt()) {
            throw fail(409, "This item changed. Reload before recording a decision.");
        }
        String result;
        if ("confirm".equals(action)) {
            result = Json.text(row, "draft_result");
        } else if ("correct".equals(action)) {
            result = Json.text(input, "result");
        } else {
            result = null;
        }
        if ("correct".equals(action) && !List.of("yes", "no", "unclear", "n_a").contains(result)) {
            throw fail(400, "Choose a valid corrected result.");
        }
        JsonNode evidence = row.path("finding").path("evidence");
        if (("yes".equals(result) || "no".equals(result)) && (!evidence.isArray() || evidence.size() == 0)) {
            throw fail(400, "Evidence must be added to a new draft before recording yes or no.");
        }
        if ("yes".equals(result) || "no".equals(result)) {
            java.util.Set<String> snapshotIds = new java.util.LinkedHashSet<>();
            for (JsonNode c : evidence) {
                snapshotIds.add(Json.text(c, "snapshot_id"));
            }
            for (String snapshotId : snapshotIds) {
                verifiedSource(row, snapshotId);
            }
        }
        String hash = Json.sha256Hex(id + ":" + (row.path("revision").asInt() + 1));
        String slot = hash.substring(0, 8) + "-" + hash.substring(8, 12) + "-8" + hash.substring(13, 16)
                + "-a" + hash.substring(17, 20) + "-" + hash.substring(20, 32);
        ObjectNode decision = Json.MAPPER.createObjectNode();
        decision.put("decision_id", slot);
        decision.put("item_id", id);
        decision.put("result_id", Json.text(row, "result_id"));
        decision.put("result_sha256", Json.text(row, "result_sha256"));
        decision.put("hospital_key", Json.text(row, "hospital_key"));
        decision.put("measure_id", Json.text(row, "measure_id"));
        decision.put("action", action);
        decision.put("result", result);
        decision.put("notes", notes.trim());
        decision.put("reviewer_role", reviewerRole.trim());
        decision.put("recorded_at", Json.toIso(Instant.now()));
        decision.put("sequence", row.path("revision").asInt() + 1);
        decision.put("identity", "self_attested_local_reviewer");
        Path decisionDirectory = root.resolve("review-inbox-decisions");
        Files.createDirectories(decisionDirectory);
        Path temporary = decisionDirectory.resolve(UUID.randomUUID() + ".tmp");
        Files.writeString(temporary, Json.MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(decision),
                StandardCharsets.UTF_8);
        try {
            Files.createLink(decisionDirectory.resolve(slot + ".json"), temporary);
        } catch (java.nio.file.FileAlreadyExistsException e) {
            throw fail(409, "This item changed. Reload before recording a decision.");
        } finally {
            Files.deleteIfExists(temporary);
        }
        return detail(id);
    }

    public SourceResult source(String id, String snapshotId) throws IOException {
        ObjectNode row = get(id, false);
        VerifiedSource verified = verifiedSource(row, snapshotId);
        String artifactPath = Json.text(verified.source(), "artifact_path");
        String contentType = artifactPath.endsWith(".docx")
                ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                : artifactPath.endsWith(".pdf") ? "application/pdf" : "text/plain; charset=utf-8";
        String disposition = artifactPath.endsWith(".docx") ? "attachment; filename=\"application.docx\"" : null;
        return new SourceResult(verified.raw(), contentType, disposition);
    }
}
