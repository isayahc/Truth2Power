package com.truth2power.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Port of backend/audit/pipeline-views.js + the publications() read path of
 * backend/audit/pipeline-store.js — reads committed pipeline assessments
 * from {@code .audit/audit.sqlite} (read-only, never creates a database)
 * and projects them into the same display records the hospital page uses.
 * When no audit.sqlite exists, no pipeline records exist — same as Node.
 */
public final class PipelineViews {

    private static final Pattern HOSTNAME = Pattern.compile("^[a-z0-9.-]+\\.[a-z]+$", Pattern.CASE_INSENSITIVE);

    private PipelineViews() {}

    /** Port of failure-diagnostic.js publicSourceUrl. */
    public static String publicSourceUrl(String value) {
        try {
            java.net.URI u = new java.net.URI(value);
            if (!"https".equalsIgnoreCase(u.getScheme()) || u.getUserInfo() != null || u.getPort() != -1) return null;
            String host = u.getHost();
            if (host == null || !HOSTNAME.matcher(host).matches()) return null;
            String lower = host.toLowerCase(java.util.Locale.ROOT);
            if (lower.endsWith(".local") || lower.endsWith(".internal") || lower.endsWith(".localhost")
                    || lower.equals("metadata.google.internal")) return null;
            if (isIp(host)) return null;
            String href = ReviewIdentity.sourceUrl(value);
            if (href.length() > 4096) return null;
            return href;
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean isIp(String host) {
        return host.matches("^[0-9.]+$") || host.contains(":");
    }

    private record Publications(List<ObjectNode> bundles, List<ObjectNode> failures) {}

    private static Publications publications(Path auditDir, Path root, boolean includeSynthetic) {
        Path dbPath = auditDir.resolve("audit.sqlite");
        if (!Files.exists(dbPath)) return new Publications(List.of(), List.of());
        List<ObjectNode> bundles = new ArrayList<>();
        List<ObjectNode> jobs = new ArrayList<>();
        try (Connection db = DriverManager.getConnection("jdbc:sqlite:file:" + dbPath + "?mode=ro")) {
            try (PreparedStatement ps = db.prepareStatement(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='pipeline_events'")) {
                ResultSet rs = ps.executeQuery();
                if (!rs.next()) return new Publications(List.of(), List.of());
            }
            try (PreparedStatement ps = db.prepareStatement(
                    "SELECT a.output,a.job FROM assessments a JOIN jobs j ON j.id=a.job "
                            + "WHERE j.rule='css-17-v1' ORDER BY a.job DESC")) {
                ResultSet rs = ps.executeQuery();
                while (rs.next()) {
                    ObjectNode bundle = (ObjectNode) Json.MAPPER.readTree(rs.getString(1));
                    bundle.put("job", rs.getLong(2));
                    String bundleRoot = Json.text(bundle, "root");
                    boolean synthetic = bundle.hasNonNull("input") && bundle.get("input").path("synthetic").asBoolean(false);
                    if (bundleRoot != null && bundleRoot.equals(root.toAbsolutePath().normalize().toString())
                            && (includeSynthetic || !synthetic)) {
                        bundles.add(bundle);
                    }
                }
            }
            for (ObjectNode b : bundles) {
                JsonNode input = b.get("input");
                JsonNode report = b.get("report");
                ObjectNode idInput = Json.MAPPER.createObjectNode();
                idInput.set("input", input);
                idInput.set("report", report);
                if (!Json.text(b, "id").equals(Json.fingerprint(idInput))) {
                    throw new IllegalStateException("Persisted assessment identity mismatch");
                }
                JsonNode agentReview = b.get("agent_review");
                JsonNode inventory = b.get("inventory");
                String inventorySha = inventory == null ? null : Json.text(inventory, "agent_review_sha256");
                if ((agentReview != null || inventorySha != null)
                        && (inventorySha == null || !inventorySha.equals(Json.fingerprint(agentReview == null
                                ? Json.MAPPER.nullNode() : agentReview)))) {
                    throw new IllegalStateException("Persisted assessment identity mismatch");
                }
                JsonNode scope = input == null ? null : input.get("scope");
                String scopeSha = scope == null ? null : Json.text(scope, "inventory_sha256");
                if (scopeSha != null && !scopeSha.equals(Json.fingerprint(inventory))) {
                    throw new IllegalStateException("Persisted assessment identity mismatch");
                }
            }
            try (PreparedStatement ps = db.prepareStatement(
                    "SELECT * FROM jobs WHERE rule='css-17-v1' ORDER BY id DESC")) {
                ResultSet rs = ps.executeQuery();
                var meta = rs.getMetaData();
                while (rs.next()) {
                    ObjectNode job = Json.MAPPER.createObjectNode();
                    for (int i = 1; i <= meta.getColumnCount(); i++) {
                        String col = meta.getColumnName(i);
                        Object v = rs.getObject(i);
                        if (v == null) job.putNull(col);
                        else if (v instanceof Number n) job.put(col, n.longValue());
                        else job.put(col, v.toString());
                    }
                    JsonNode context = Json.MAPPER.readTree(job.get("context").asText());
                    job.set("context", context);
                    String ctxRoot = Json.text(context, "root");
                    String mode = Json.text(context, "mode");
                    boolean syntheticMode = "synthetic".equals(mode);
                    if (ctxRoot != null && ctxRoot.equals(root.toAbsolutePath().normalize().toString())
                            && (includeSynthetic || !syntheticMode)) {
                        jobs.add(job);
                    }
                }
            }
        } catch (IllegalStateException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("Pipeline publications could not be read", e);
        }
        List<ObjectNode> failures = new ArrayList<>();
        for (ObjectNode j : jobs) {
            JsonNode context = j.get("context");
            if (j.hasNonNull("error") && !"discovery_only".equals(Json.text(context, "mode"))) failures.add(j);
        }
        return new Publications(bundles, failures);
    }

    /** The committed pipeline bundles (for the review inbox's pipeline drafts). */
    public static List<ObjectNode> pipelineBundles(Path auditDir, Path root) {
        boolean includeSynthetic = "1".equals(System.getenv("T2P_PILOT_DEMO"));
        return publications(auditDir, root, includeSynthetic).bundles();
    }

    /**
     * The stored pipeline change events (for GET /api/changes): the
     * pipeline_events rows, newest job first, restricted to jobs that have a
     * committed bundle — same as publications(root).events in pipeline-store.js.
     */
    public static List<ObjectNode> pipelineEvents(Path auditDir, Path root) {
        boolean includeSynthetic = "1".equals(System.getenv("T2P_PILOT_DEMO"));
        Publications pubs = publications(auditDir, root, includeSynthetic);
        java.util.Set<Long> ids = new java.util.HashSet<>();
        for (ObjectNode b : pubs.bundles()) {
            ids.add(b.get("job").asLong());
        }
        if (ids.isEmpty()) {
            return List.of();
        }
        Path dbPath = auditDir.resolve("audit.sqlite");
        if (!Files.exists(dbPath)) {
            return List.of();
        }
        List<ObjectNode> events = new ArrayList<>();
        try (Connection db = DriverManager.getConnection("jdbc:sqlite:file:" + dbPath + "?mode=ro")) {
            try (PreparedStatement ps = db.prepareStatement(
                    "SELECT job,output FROM pipeline_events ORDER BY job DESC")) {
                ResultSet rs = ps.executeQuery();
                while (rs.next()) {
                    if (!ids.contains(rs.getLong(1))) {
                        continue;
                    }
                    events.add((ObjectNode) Json.MAPPER.readTree(rs.getString(2)));
                }
            }
        } catch (Exception e) {
            throw new IllegalStateException("Pipeline events could not be read", e);
        }
        return events;
    }

    /** Port of reviewEnvelope(bundle) from pipeline-views.js. */
    public static ObjectNode reviewEnvelope(ObjectNode bundle) {
        JsonNode input = bundle.get("input");
        JsonNode report = bundle.get("report");
        String id = Json.text(bundle, "id");
        ObjectNode env = Json.MAPPER.createObjectNode();
        env.put("review_id", id.substring(0, 32));
        env.put("result_id", id.substring(32));
        env.put("hospital_key", Json.text(input, "hospital_key"));
        env.put("rubric_version", Json.text(input, "rubric_version"));
        env.put("guideline_year", input.get("guideline_year").asInt());
        if (Json.text(input, "reference_version") != null) env.put("reference_version", Json.text(input, "reference_version"));
        else env.putNull("reference_version");
        env.put("checked_at", Json.text(report, "last_successful_assessment_at"));
        if (Json.text(input, "review_date") != null) env.put("review_date", Json.text(input, "review_date"));
        else env.putNull("review_date");
        env.put("publication_job", bundle.get("job").asLong());
        boolean synthetic = input.path("synthetic").asBoolean(false);
        String mode = Json.text(bundle, "mode");
        env.put("scope_label", (synthetic ? "SYNTHETIC — " : "") + "Integrated 17-measure "
                + (mode != null ? mode : "replay") + " assessment · " + id.substring(0, 12));
        ArrayNode snapshots = Json.MAPPER.createArrayNode();
        for (JsonNode s : Json.array(input, "sources")) {
            if (!s.hasNonNull("snapshot")) continue;
            ObjectNode snap = (ObjectNode) s.get("snapshot").deepCopy();
            snap.put("document_type", Json.text(s, "role"));
            snapshots.add(snap);
        }
        env.set("snapshots", snapshots);
        ArrayNode coverage = Json.MAPPER.createArrayNode();
        for (JsonNode s : Json.array(input, "sources")) {
            ObjectNode c = Json.MAPPER.createObjectNode();
            c.put("source_id", Json.text(s, "source_id"));
            c.put("url", Json.text(s, "source_id"));
            if (Json.text(s, "language") != null) c.put("language", Json.text(s, "language"));
            else c.putNull("language");
            c.put("status", Json.text(s, "status"));
            JsonNode snap = s.get("snapshot");
            if (snap != null && Json.text(snap, "snapshot_id") != null) c.put("snapshot_id", Json.text(snap, "snapshot_id"));
            else c.putNull("snapshot_id");
            c.put("notes", "Scope and interpretation remain as recorded in the immutable grading input.");
            coverage.add(c);
        }
        env.set("coverage", coverage);
        ArrayNode gaps = Json.MAPPER.createArrayNode();
        for (JsonNode g : Json.array(report, "coverage_gaps")) {
            ObjectNode gap = Json.MAPPER.createObjectNode();
            gap.put("reason", g.asText());
            gaps.add(gap);
        }
        env.set("gaps", gaps);
        ArrayNode findings = Json.MAPPER.createArrayNode();
        for (JsonNode f : Json.array(report, "findings")) {
            ObjectNode nf = Json.MAPPER.createObjectNode();
            nf.put("measure_id", Json.text(f, "measure_id"));
            nf.put("result", Json.text(f, "result"));
            nf.put("explanation", Json.text(f, "reason"));
            if (f.has("expected")) nf.set("expected", f.get("expected"));
            else nf.putNull("expected");
            ArrayNode evidence = Json.MAPPER.createArrayNode();
            for (JsonNode e : Json.array(f, "evidence")) {
                ObjectNode ne = Json.MAPPER.createObjectNode();
                ne.put("snapshot_id", Json.text(e, "snapshot_id"));
                ne.put("locator", Json.text(e, "locator"));
                ne.put("quote", Json.text(e, "quote"));
                evidence.add(ne);
            }
            nf.set("evidence", evidence);
            nf.set("unresolved_questions", f.has("coverage_gaps") ? f.get("coverage_gaps") : Json.MAPPER.createArrayNode());
            findings.add(nf);
        }
        env.set("findings", findings);
        return env;
    }

    /** Public view of a bundle's agent review, for the revision endpoint. */
    public static ObjectNode agentReview(ObjectNode bundle, long jobId) {
        return publicAgentReview(bundle, jobId);
    }

    private static ObjectNode publicAgentReview(ObjectNode bundle, long jobId) {
        JsonNode review = bundle.get("agent_review");
        if (review == null || review.isNull()) return null;
        String bundleId = Json.text(bundle, "id");
        String revisionUrl = "/api/pilot/v1/runs/audit-run-" + jobId + "/revision/" + bundleId;
        java.util.function.Function<JsonNode, ObjectNode> cite = c -> {
            ObjectNode out = Json.MAPPER.createObjectNode();
            out.put("source_id", publicSourceUrl(Json.text(c, "source_id")));
            out.put("sha256", Json.text(c, "sha256"));
            out.put("quote", Json.text(c, "quote"));
            String locator = Json.text(c, "locator");
            if (locator != null && locator.startsWith("link ")) {
                String target = publicSourceUrl(locator.substring(5));
                out.put("locator", "link " + (target != null ? target : "on saved page"));
            } else {
                out.put("locator", locator);
            }
            out.put("download", revisionUrl + "/snapshots/" + Json.text(c, "sha256"));
            return out;
        };
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.put("status", Json.text(review, "status"));
        out.set("agents", review.get("agents"));
        out.put("omitted_passages", review.path("omitted_passages").asInt(0));
        ArrayNode findings = Json.MAPPER.createArrayNode();
        for (JsonNode f : Json.array(review, "findings")) {
            ObjectNode nf = Json.MAPPER.createObjectNode();
            nf.put("measure_id", Json.text(f, "measure_id"));
            nf.put("result", Json.text(f, "result"));
            nf.put("explanation", Json.text(f, "explanation"));
            nf.put("revision_url", revisionUrl);
            ArrayNode evidence = Json.MAPPER.createArrayNode();
            for (JsonNode e : Json.array(f, "evidence")) evidence.add(cite.apply(e));
            nf.set("evidence", evidence);
            if (f.hasNonNull("identity_basis")) {
                ArrayNode basis = Json.MAPPER.createArrayNode();
                for (JsonNode i : Json.array(f, "identity_basis")) {
                    ObjectNode ni = Json.MAPPER.createObjectNode();
                    ni.put("source_id", publicSourceUrl(Json.text(i, "source_id")));
                    ni.put("proposed_role", Json.text(i, "proposed_role"));
                    ArrayNode bev = Json.MAPPER.createArrayNode();
                    for (JsonNode e : Json.array(i, "evidence")) bev.add(cite.apply(e));
                    ni.set("evidence", bev);
                    basis.add(ni);
                }
                nf.set("identity_basis", basis);
            }
            findings.add(nf);
        }
        out.set("findings", findings);
        return out;
    }

    /** Port of publishedRecords(root) — the integrated pipeline assessments as display records. */
    public static List<ObjectNode> publishedRecords(Path auditDir, Path root) {
        boolean includeSynthetic = "1".equals(System.getenv("T2P_PILOT_DEMO"));
        Publications pubs = publications(auditDir, root, includeSynthetic);
        Map<String, ObjectNode> selected = new LinkedHashMap<>();
        for (ObjectNode b : pubs.bundles()) {
            String key = Json.text(b.get("input"), "hospital_key") + "/" + b.get("input").get("guideline_year").asInt();
            selected.putIfAbsent(key, b);
        }
        List<ObjectNode> records = new ArrayList<>();
        for (ObjectNode b : selected.values()) {
            JsonNode input = b.get("input");
            JsonNode report = b.get("report");
            ObjectNode envelope = reviewEnvelope(b);
            ObjectNode agentReview = publicAgentReview(b, b.get("job").asLong());
            List<JsonNode> sourceReviews = new ArrayList<>();
            JsonNode inventory = b.get("inventory");
            if (inventory != null) {
                for (JsonNode s : Json.array(inventory, "sources")) {
                    if (s.hasNonNull("review")) sourceReviews.add(s);
                }
            }
            ObjectNode record = Json.MAPPER.createObjectNode();
            record.put("hospital_key", Json.text(input, "hospital_key"));
            record.put("record_id", Json.text(b, "id"));
            record.put("scope", "integrated-assessment");
            record.put("kind", "pipeline");
            record.put("synthetic", input.path("synthetic").asBoolean(false));
            record.put("scope_label", Json.text(envelope, "scope_label"));
            record.put("guideline_year", input.get("guideline_year").asInt());
            if (Json.text(input, "review_date") != null) record.put("review_date", Json.text(input, "review_date"));
            else record.putNull("review_date");
            record.put("checked_at", Json.text(envelope, "checked_at"));
            record.put("status", "completed");
            record.set("report", report);
            record.put("audit_mode", Json.text(b, "mode") != null ? Json.text(b, "mode") : "replay");
            List<String> monitoring = new ArrayList<>();
            for (JsonNode s : Json.array(input, "sources")) {
                if (!s.hasNonNull("snapshot")) continue;
                String role = Json.text(s, "role");
                if ("uniform_reference".equals(role) || "psa_reference".equals(role)) continue;
                monitoring.add(Json.text(s.get("snapshot"), "retrieved_at"));
            }
            monitoring.sort((x, y) -> Json.parseDate(x).compareTo(Json.parseDate(y)));
            if (monitoring.isEmpty()) record.putNull("monitoring_at");
            else record.put("monitoring_at", monitoring.get(0));
            ArrayNode landing = Json.MAPPER.createArrayNode();
            for (JsonNode s : Json.array(input, "sources")) {
                if ("landing_page".equals(Json.text(s, "role")) && s.hasNonNull("snapshot")) {
                    landing.add(s.get("snapshot"));
                }
            }
            record.set("landing_page", landing);
            if (agentReview != null && agentReview.has("findings") && agentReview.get("findings").size() > 0) {
                record.set("agent_findings", agentReview.get("findings"));
            }
            ArrayNode findings = Json.MAPPER.createArrayNode();
            List<JsonNode> reportFindings = Json.array(report, "findings");
            List<JsonNode> envelopeFindings = Json.array(envelope, "findings");
            for (int index = 0; index < envelopeFindings.size(); index++) {
                JsonNode f = envelopeFindings.get(index);
                ObjectNode nf = (ObjectNode) f.deepCopy();
                ArrayNode passages = Json.MAPPER.createArrayNode();
                for (JsonNode s : sourceReviews) {
                    JsonNode review = s.get("review");
                    List<JsonNode> observations = new ArrayList<>();
                    JsonNode obs = review.get("observations");
                    if (obs != null && obs.has(Json.text(f, "measure_id"))) {
                        obs.get(Json.text(f, "measure_id")).forEach(observations::add);
                    }
                    JsonNode rf = reportFindings.get(index);
                    for (JsonNode p : observations) {
                        boolean alreadyCited = false;
                        for (JsonNode e : Json.array(rf, "evidence")) {
                            if (Json.text(e, "source_id") != null
                                    && Json.text(e, "source_id").equals(Json.text(s, "source_id"))
                                    && Json.text(e, "locator").equals(Json.text(p, "locator"))
                                    && Json.text(e, "quote").equals(Json.text(p, "quote"))) {
                                alreadyCited = true;
                                break;
                            }
                        }
                        if (alreadyCited) continue;
                        ObjectNode np = (ObjectNode) p.deepCopy();
                        np.put("source_url", Json.text(s, "source_id"));
                        np.put("sha256", Json.text(s, "digest"));
                        np.put("saved_url", "/api/pilot/snapshots/" + Json.text(s, "digest"));
                        np.put("worker", Json.text(review, "worker"));
                        np.put("role", Json.text(s, "role"));
                        np.put("language", Json.text(s, "language"));
                        np.put("campus", Json.text(s, "campus_applicability"));
                        passages.add(np);
                    }
                }
                nf.set("candidate_passages", passages);
                ArrayNode evidence = Json.MAPPER.createArrayNode();
                JsonNode rf = reportFindings.get(index);
                List<JsonNode> fEvidence = Json.array(f, "evidence");
                for (int i = 0; i < fEvidence.size(); i++) {
                    JsonNode e = fEvidence.get(i);
                    JsonNode rfEvidence = Json.array(rf, "evidence").get(i);
                    JsonNode s = null;
                    for (JsonNode cand : Json.array(envelope, "snapshots")) {
                        if (Json.text(cand, "url") != null
                                && Json.text(cand, "url").equals(Json.text(rfEvidence, "source_id"))
                                && Json.text(cand, "snapshot_id") != null
                                && Json.text(cand, "snapshot_id").equals(Json.text(e, "snapshot_id"))) {
                            s = cand;
                            break;
                        }
                    }
                    if (s == null) throw new IllegalStateException("Published evidence snapshot not found");
                    ObjectNode ne = (ObjectNode) e.deepCopy();
                    // {...e, ...s, saved_url} — snapshot fields win on conflict.
                    for (var field : Json.fields(s)) ne.set(field.getKey(), field.getValue());
                    ne.put("saved_url", "/api/pilot/snapshots/" + Json.text(s, "sha256"));
                    evidence.add(ne);
                }
                nf.set("evidence", evidence);
                findings.add(nf);
            }
            record.set("findings", findings);
            ArrayNode affected = Json.MAPPER.createArrayNode();
            for (JsonNode f : envelopeFindings) affected.add(Json.text(f, "measure_id"));
            record.set("affected_measures", affected);
            records.add(record);
            for (ObjectNode failure : pubs.failures()) {
                if (!Json.text(failure, "hospital").equals(Json.text(input, "hospital_key"))) continue;
                if (failure.get("year").asInt() != input.get("guideline_year").asInt()) continue;
                if (failure.get("id").asLong() <= b.get("job").asLong()) continue;
                ObjectNode frec = Json.MAPPER.createObjectNode();
                frec.put("hospital_key", Json.text(failure, "hospital"));
                frec.put("record_id", "failed-" + failure.get("id").asLong() + "-" + failure.get("attempts").asLong());
                frec.put("kind", "pipeline");
                frec.put("scope", "integrated-assessment");
                frec.put("scope_label", Json.text(envelope, "scope_label"));
                frec.put("guideline_year", failure.get("year").asInt());
                frec.put("checked_at", Json.text(failure, "attempted"));
                frec.put("status", "failed");
                frec.put("error", Json.text(failure, "error"));
                frec.set("findings", Json.MAPPER.createArrayNode());
                frec.set("affected_measures", affected.deepCopy());
                records.add(frec);
            }
        }
        return records;
    }
}
