package com.truth2power.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.truth2power.config.RepoPaths;
import java.io.IOException;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Service;

/**
 * The reporting read surface — port of backend/audit/reporting-api.js
 * ({@code projection}, {@code runRow}, {@code publicEvent}, {@code clocks},
 * {@code publicReceipt}, {@code summary}, operations, {@code runDocuments},
 * {@code revision}, {@code attachment}, {@code gapTypes}) plus
 * {@code interventionFor} (interventions.js).
 *
 * <p>All SQL is the old app's, verbatim where possible. Reads go through a
 * read-only connection opened by the controller; a null connection means no
 * audit.sqlite exists and the history is empty (never an error).
 */
@Service
public class AuditRunService {

    public static final String BASE = "/api/pilot/v1";
    public static final String VERSION = "audit-reporting-v1";

    private static final Set<String> STAGES = Set.of("load_saved_evidence", "collect_sources",
            "collection_saved", "collection_stopped", "extract_documents", "model_review",
            "reconcile_evidence", "restore_checkpoint", "grade");

    private static final List<String> MODES = List.of("replay", "full_audit", "live", "discovery_only");
    private static final List<String> STATUSES = List.of("queued", "running", "retrying", "partial",
            "completed", "failed", "cancelled", "needs_human");

    /** The committed-projection SQL from reporting-api.js, verbatim. */
    private static final String PROJECTION =
            "SELECT j.id,j.hospital,j.attempted,j.attempts,j.year,json_extract(j.context,'$.mode') mode,\n"
                    + "  (SELECT at FROM audit_run_events WHERE job=j.id AND state='queued' ORDER BY seq LIMIT 1) queued_at,\n"
                    + "  COALESCE(e.state, CASE WHEN j.status='failed' AND EXISTS(SELECT 1 FROM audit_run_events x WHERE x.job=j.id AND json_extract(x.detail,'$.error_code')='website_verification_required') AND NOT EXISTS(SELECT 1 FROM audit_run_events x WHERE x.job=j.id AND x.state='human_resumed') THEN 'needs_human' WHEN j.status='queued' AND j.error IS NOT NULL THEN 'retrying' ELSE j.status END) status,\n"
                    + "  json_extract(a.output,'$.id') assessment_id,json_extract(j.checkpoint,'$.scan_id') scan_id,\n"
                    + "  a.completed assessed_at,COALESCE(e.at,a.completed) completed_at,\n"
                    + "  json_extract(e.detail,'$.coverage_gaps') gaps,json_extract(e.detail,'$.unresolved_measures') unresolved,\n"
                    + "  (SELECT max(julianday(json_extract(c.value,'$.retrieved_at'))) FROM json_each(e.detail,'$.captures') c) fetched_jd\n"
                    + "  FROM jobs j LEFT JOIN assessments a ON a.job=j.id LEFT JOIN audit_run_events e ON e.job=j.id AND e.state IN ('partial','completed')\n"
                    + "  WHERE j.rule='css-17-v1' AND json_extract(j.context,'$.root')=? AND json_extract(j.context,'$.mode') IN ('live','full_audit','discovery_only','replay')";

    private final RepoPaths paths;
    private final AuditStore store;

    /** Roster id -> {hospital_key, pfi, name, region}, built once from the geojson. */
    private volatile Map<String, ObjectNode> hospitals;

    public AuditRunService(RepoPaths paths, AuditStore store) {
        this.paths = paths;
        this.store = store;
    }

    public static String runId(long job) {
        return "audit-run-" + job;
    }

    // -- query-string helpers (reporting-api.js integer/params/page) --------

    /** Port of {@code integer(value, max)}: positive safe integer at most max. */
    public static long integer(String value, long max) {
        if (value == null || !value.matches("^[1-9]\\d*$")) {
            throw AuditException.fail(400, "invalid_parameter");
        }
        try {
            long n = Long.parseLong(value);
            if (n > max) {
                throw AuditException.fail(400, "invalid_parameter");
            }
            return n;
        } catch (NumberFormatException e) {
            throw AuditException.fail(400, "invalid_parameter");
        }
    }

    /** Port of {@code params(q, keys)}: any key outside the whitelist is a 400. */
    public static void params(Map<String, String> query, String... keys) {
        Set<String> allowed = Set.of(keys);
        for (String k : query.keySet()) {
            if (!allowed.contains(k)) {
                throw AuditException.fail(400, "invalid_parameter");
            }
        }
    }

    /** Port of {@code page(rows, limit, key)}: first page + next_cursor. */
    public static ObjectNode page(List<ObjectNode> rows, int limit, String key) {
        boolean more = rows.size() > limit;
        List<ObjectNode> items = rows.subList(0, Math.min(limit, rows.size()));
        ObjectNode out = Json.MAPPER.createObjectNode();
        ArrayNode arr = Json.MAPPER.createArrayNode();
        for (ObjectNode item : items) {
            arr.add(item);
        }
        out.set("items", arr);
        if (more) {
            out.put("next_cursor", items.get(items.size() - 1).path(key).asText());
        } else {
            out.putNull("next_cursor");
        }
        return out;
    }

    // -- roster -------------------------------------------------------------

    private static String countyKey(String s) {
        return s == null ? "" : s.toLowerCase().replace(".", "");
    }

    /** The reporting-api.js hospitals map, from the same geojson + regions file. */
    public Map<String, ObjectNode> hospitals() {
        Map<String, ObjectNode> cached = hospitals;
        if (cached != null) {
            return cached;
        }
        synchronized (this) {
            if (hospitals != null) {
                return hospitals;
            }
            Map<String, ObjectNode> out = new LinkedHashMap<>();
            try {
                JsonNode regions = Json.readFile(paths.referencesDir().resolve("ny-economic-regions-v1.json"))
                        .path("regions");
                JsonNode geo = Json.readFile(paths.mapsDir().resolve("hospitals.geojson"));
                for (JsonNode feature : geo.path("features")) {
                    String id = feature.path("id").asText();
                    JsonNode p = feature.path("properties");
                    String county = Json.text(p, "county");
                    String region = null;
                    for (Map.Entry<String, JsonNode> e : Json.fields(regions)) {
                        for (JsonNode c : e.getValue()) {
                            if (countyKey(c.asText()).equals(countyKey(county))) {
                                region = e.getKey();
                                break;
                            }
                        }
                        if (region != null) {
                            break;
                        }
                    }
                    ObjectNode h = Json.MAPPER.createObjectNode();
                    h.put("hospital_key", id);
                    String pfi = Json.text(p, "pfi");
                    if (pfi == null) {
                        h.putNull("pfi");
                    } else {
                        h.put("pfi", pfi);
                    }
                    h.put("name", Json.text(p, "name"));
                    if (region == null) {
                        h.putNull("region");
                    } else {
                        h.put("region", region);
                    }
                    out.put(id, h);
                }
            } catch (IOException e) {
                throw new IllegalStateException("Could not load hospital roster", e);
            }
            hospitals = out;
            return out;
        }
    }

    // -- rows ---------------------------------------------------------------

    /** One row of the projection, as the old code sees it. */
    public record RunData(long id, String hospital, String attempted, int attempts, int year,
                          String mode, String queuedAt, String status, String assessmentId,
                          String scanId, String assessedAt, String completedAt,
                          JsonNode gaps, JsonNode unresolved) {
    }

    private static RunData readRun(ResultSet rs) throws SQLException {
        JsonNode gaps = parseOrNull(rs.getString("gaps"));
        JsonNode unresolved = parseOrNull(rs.getString("unresolved"));
        return new RunData(rs.getLong("id"), rs.getString("hospital"), rs.getString("attempted"),
                rs.getInt("attempts"), rs.getInt("year"), rs.getString("mode"),
                rs.getString("queued_at"), rs.getString("status"),
                rs.getString("assessment_id"), rs.getString("scan_id"),
                rs.getString("assessed_at"), rs.getString("completed_at"), gaps, unresolved);
    }

    private static JsonNode parseOrNull(String text) {
        if (text == null) {
            return null;
        }
        try {
            return Json.MAPPER.readTree(text);
        } catch (Exception e) {
            return null;
        }
    }

    private List<RunData> queryRuns(Connection db, String sql, Object... args) throws SQLException {
        List<RunData> out = new ArrayList<>();
        try (PreparedStatement ps = db.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) {
                ps.setObject(i + 1, args[i]);
            }
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    out.add(readRun(rs));
                }
            }
        }
        return out;
    }

    /** Port of {@code runRow(r)}. */
    public static ObjectNode runRow(RunData r) {
        String path = BASE + "/runs/" + runId(r.id());
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.put("audit_run_id", runId(r.id()));
        out.put("job_id", r.id());
        out.put("hospital_key", r.hospital());
        out.put("year", r.year());
        out.put("mode", r.mode());
        out.put("status", r.status());
        if (r.queuedAt() == null) {
            out.putNull("queued_at");
        } else {
            out.put("queued_at", r.queuedAt());
        }
        if (r.attempted() == null) {
            out.putNull("attempted_at");
        } else {
            out.put("attempted_at", r.attempted());
        }
        if (r.completedAt() == null) {
            out.putNull("completed_at");
        } else {
            out.put("completed_at", r.completedAt());
        }
        out.put("attempts", r.attempts());
        String evidence = r.gaps() == null ? "unknown"
                : "partial".equals(r.status()) ? "partial" : "complete";
        out.put("evidence", evidence);
        out.set("unresolved_measures", r.unresolved() == null ? Json.MAPPER.nullNode() : r.unresolved());
        out.set("coverage_gaps", r.gaps() == null ? Json.MAPPER.nullNode() : r.gaps());
        if (r.assessmentId() == null) {
            out.putNull("assessment_id");
        } else {
            out.put("assessment_id", r.assessmentId());
        }
        if (r.scanId() == null) {
            out.putNull("scan_id");
        } else {
            out.put("scan_id", r.scanId());
        }
        out.put("timeline", path + "/timeline");
        out.put("receipt", path + "/receipt");
        String revision = r.assessmentId() != null ? r.assessmentId() : r.scanId();
        if (revision == null) {
            out.putNull("revision");
        } else {
            out.put("revision", path + "/revision/" + revision);
        }
        return out;
    }

    /** One audit_run_events row, as publicEvent reads it. */
    private record EventData(long seq, String state, Long captureCount, String at, String attempt,
                             String stage, String stopCode, String errorCode, JsonNode diagnostic,
                             Boolean retryScheduled, JsonNode documentAttempts) {
    }

    /** Port of {@code publicEvent(e)}. */
    public static ObjectNode publicEvent(EventData e) {
        ObjectNode diagnostic = AuditDiagnostics.failureDiagnostic(e.errorCode(), e.diagnostic());
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.put("seq", e.seq());
        out.put("state", e.state());
        if (e.captureCount() == null) {
            out.putNull("captured_sources");
        } else {
            out.put("captured_sources", e.captureCount());
        }
        out.put("at", e.at());
        if (e.attempt() == null) {
            out.putNull("attempt_id");
        } else {
            out.put("attempt_id", Json.sha256Hex(e.attempt()));
        }
        if (e.stage() != null && STAGES.contains(e.stage())) {
            out.put("stage", e.stage());
        } else {
            out.putNull("stage");
        }
        if (diagnostic == null) {
            out.putNull("diagnostic");
        } else {
            out.set("diagnostic", diagnostic);
        }
        if (e.retryScheduled() == null) {
            out.putNull("retry_scheduled");
        } else {
            out.put("retry_scheduled", e.retryScheduled());
        }
        String reason = e.stopCode();
        if (reason == null && diagnostic != null) {
            reason = Json.text(diagnostic, "code");
        }
        if (reason == null) {
            reason = switch (e.state()) {
                case "failed" -> "audit_failed";
                case "interrupted" -> "lease_expired";
                case "retrying" -> "retry_scheduled";
                case "cancelled" -> "operator_cancelled";
                default -> null;
            };
        }
        if (reason == null) {
            out.putNull("reason");
        } else {
            out.put("reason", reason);
        }
        return out;
    }

    private static EventData readEvent(ResultSet rs) throws SQLException {
        Long captureCount = null;
        long cc = rs.getLong("capture_count");
        if (!rs.wasNull()) {
            captureCount = cc;
        }
        Boolean retryScheduled = null;
        int rsched = rs.getInt("retry_scheduled");
        if (!rs.wasNull()) {
            retryScheduled = rsched != 0;
        }
        return new EventData(rs.getLong("seq"), rs.getString("state"), captureCount,
                rs.getString("at"), rs.getString("attempt"), rs.getString("stage"),
                rs.getString("stop_code"), rs.getString("error_code"),
                parseOrNull(rs.getString("diagnostic")), retryScheduled,
                parseOrNull(rs.getString("document_attempts")));
    }

    private static final String EVENT_COLUMNS =
            "seq,attempt,state,at,json_extract(detail,'$.name') stage,"
                    + "json_extract(detail,'$.stop_code') stop_code,"
                    + "json_extract(detail,'$.error_code') error_code,"
                    + "json_extract(detail,'$.diagnostic') diagnostic,"
                    + "json_extract(detail,'$.retry_scheduled') retry_scheduled,"
                    + "json_extract(detail,'$.document_attempts') document_attempts,"
                    + "json_array_length(detail,'$.captures') capture_count";

    // -- clocks -------------------------------------------------------------

    /** Port of {@code clocks(db, key)}. Null db means all clocks null. */
    public ObjectNode clocks(Connection db, String key) throws SQLException {
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.putNull("last_attempted");
        out.putNull("last_completed_execution");
        out.putNull("last_successful_source_retrieval");
        out.putNull("last_eligible_assessment");
        out.putNull("next_due_at");
        if (db == null) {
            return out;
        }
        String sql = "WITH runs AS (" + PROJECTION + ") SELECT max(attempted) last_attempted,\n"
                + "    max(completed_at) last_completed_execution,"
                + "strftime('%Y-%m-%dT%H:%M:%fZ',max(fetched_jd)) last_successful_source_retrieval,\n"
                + "    strftime('%Y-%m-%dT%H:%M:%fZ',max(fetched_jd)+30) next_due_at,\n"
                + "    (SELECT assessed_at FROM runs WHERE hospital=? AND mode IN ('live','full_audit') "
                + "AND assessment_id IS NOT NULL ORDER BY id DESC LIMIT 1) last_eligible_assessment\n"
                + "    FROM runs WHERE hospital=?";
        try (PreparedStatement ps = db.prepareStatement(sql)) {
            ps.setString(1, store.pipelineRoot().toString());
            ps.setString(2, key);
            ps.setString(3, key);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    putNullable(out, "last_attempted", rs.getString("last_attempted"));
                    putNullable(out, "last_completed_execution", rs.getString("last_completed_execution"));
                    putNullable(out, "last_successful_source_retrieval",
                            rs.getString("last_successful_source_retrieval"));
                    putNullable(out, "last_eligible_assessment", rs.getString("last_eligible_assessment"));
                    putNullable(out, "next_due_at", rs.getString("next_due_at"));
                }
            }
        }
        return out;
    }

    private static void putNullable(ObjectNode out, String field, String value) {
        if (value == null) {
            out.putNull(field);
        } else {
            out.put(field, value);
        }
    }

    // -- facility runs list -------------------------------------------------

    /** GET /hospitals/{key}/runs — the response body without schema_version. */
    public ObjectNode facilityRuns(Connection db, String key, int limit, long cursor) throws SQLException {
        List<RunData> rows = db == null ? List.of()
                : queryRuns(db, "SELECT * FROM (" + PROJECTION + ") WHERE hospital=? AND id<? "
                        + "ORDER BY id DESC LIMIT ?", store.pipelineRoot().toString(), key, cursor, limit + 1);
        List<ObjectNode> mapped = new ArrayList<>();
        for (RunData r : rows) {
            mapped.add(runRow(r));
        }
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.set("hospital", hospitals().get(key));
        out.set("agent_review", AuditBudgets.fullAuditReview());
        ObjectNode preflight = Json.MAPPER.createObjectNode();
        for (String mode : MODES) {
            preflight.set(mode, AuditBudgets.preview(AuditBudgets.budgetPolicy(), mode));
        }
        out.set("preflight", preflight);
        out.set("clocks", clocks(db, key));
        ObjectNode paged = page(mapped, limit, "job_id");
        out.set("items", paged.path("items"));
        out.set("next_cursor", paged.path("next_cursor"));
        return out;
    }

    /** The single projected run row, or null. */
    public RunData findRun(Connection db, long id) throws SQLException {
        if (db == null) {
            return null;
        }
        List<RunData> rows = queryRuns(db, "SELECT * FROM (" + PROJECTION + ") WHERE id=?",
                store.pipelineRoot().toString(), id);
        return rows.isEmpty() ? null : rows.get(0);
    }

    // -- run detail / timeline / log ----------------------------------------

    /** GET /runs/audit-run-{id} — runRow + documents + attempt_history. */
    public ObjectNode runDetail(Connection db, RunData r) throws SQLException {
        ObjectNode out = runRow(r);
        out.set("documents", runDocuments(db, r));
        List<AttemptRow> attempts = new ArrayList<>();
        try (PreparedStatement ps = db.prepareStatement(
                "SELECT token,started,status FROM attempts WHERE job=? ORDER BY started,rowid LIMIT 100")) {
            ps.setLong(1, r.id());
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    attempts.add(new AttemptRow(rs.getString("token"), rs.getString("started"),
                            rs.getString("status")));
                }
            }
        }
        ArrayNode history = Json.MAPPER.createArrayNode();
        for (AttemptRow a : attempts) {
            ObjectNode row = Json.MAPPER.createObjectNode();
            row.put("attempt_id", Json.sha256Hex(a.token()));
            row.put("started_at", a.started());
            row.put("status", a.status());
            history.add(row);
        }
        out.set("attempt_history", history);
        return out;
    }

    private record AttemptRow(String token, String started, String status) {
    }

    /** GET /runs/audit-run-{id}/timeline — paged public events, oldest first. */
    public ObjectNode timeline(Connection db, long id, int limit, long cursor) throws SQLException {
        List<EventData> rows = new ArrayList<>();
        try (PreparedStatement ps = db.prepareStatement(
                "SELECT " + EVENT_COLUMNS + " FROM audit_run_events "
                        + "WHERE job=? AND seq>? ORDER BY seq LIMIT ?")) {
            ps.setLong(1, id);
            ps.setLong(2, cursor);
            ps.setLong(3, limit + 1);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    rows.add(readEvent(rs));
                }
            }
        }
        List<ObjectNode> mapped = new ArrayList<>();
        for (EventData e : rows) {
            mapped.add(publicEvent(e));
        }
        return page(mapped, limit, "seq");
    }

    /** GET /runs/audit-run-{id}/log.json — the export object (controller pretty-prints). */
    public ObjectNode logJson(Connection db, RunData r) throws SQLException {
        List<EventData> events = new ArrayList<>();
        try (PreparedStatement ps = db.prepareStatement(
                "SELECT seq,attempt,state,at,json_extract(detail,'$.name') stage,"
                        + "json_extract(detail,'$.stop_code') stop_code,"
                        + "json_extract(detail,'$.error_code') error_code,"
                        + "json_extract(detail,'$.diagnostic') diagnostic,"
                        + "json_extract(detail,'$.retry_scheduled') retry_scheduled,"
                        + "json_extract(detail,'$.document_attempts') document_attempts,"
                        + " json_array_length(detail,'$.captures') capture_count "
                        + "FROM audit_run_events WHERE job=? ORDER BY seq")) {
            ps.setLong(1, r.id());
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    events.add(readEvent(rs));
                }
            }
        }
        List<AttemptRow> attempts = new ArrayList<>();
        try (PreparedStatement ps = db.prepareStatement(
                "SELECT token,started,status FROM attempts WHERE job=? ORDER BY started,rowid")) {
            ps.setLong(1, r.id());
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    attempts.add(new AttemptRow(rs.getString("token"), rs.getString("started"),
                            rs.getString("status")));
                }
            }
        }
        ObjectNode handoff = interventionFor(db, r.id(), r.hospital());
        if (handoff != null) {
            ArrayNode docs = Json.MAPPER.createArrayNode();
            for (JsonNode d : handoff.path("documents")) {
                ObjectNode copy = (ObjectNode) d.deepCopy();
                copy.remove("artifact_path");
                docs.add(copy);
            }
            handoff.set("documents", docs);
        }
        ObjectNode origin = null;
        try (PreparedStatement ps = db.prepareStatement(
                "SELECT json_extract(detail,'$.parent_run_id') parent_run_id, "
                        + "json_extract(detail,'$.manifest_sha256') manifest_sha256 "
                        + "FROM audit_run_events WHERE job=? AND state='human_import_linked' "
                        + "ORDER BY seq LIMIT 1")) {
            ps.setLong(1, r.id());
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    origin = Json.MAPPER.createObjectNode();
                    String parent = rs.getString("parent_run_id");
                    String manifest = rs.getString("manifest_sha256");
                    if (parent == null) {
                        origin.putNull("parent_run_id");
                    } else {
                        origin.put("parent_run_id", parent);
                    }
                    if (manifest == null) {
                        origin.putNull("manifest_sha256");
                    } else {
                        origin.put("manifest_sha256", manifest);
                    }
                }
            }
        }
        ArrayNode timeline = Json.MAPPER.createArrayNode();
        for (EventData e : events) {
            ObjectNode ev = publicEvent(e);
            if (e.documentAttempts() != null) {
                ObjectNode collection = Json.MAPPER.createObjectNode();
                collection.set("documents", e.documentAttempts());
                ev.set("document_attempts", AuditDiagnostics.documentAttempts(collection));
            }
            timeline.add(ev);
        }
        ArrayNode attemptsNode = Json.MAPPER.createArrayNode();
        for (AttemptRow a : attempts) {
            ObjectNode row = Json.MAPPER.createObjectNode();
            row.put("attempt_id", Json.sha256Hex(a.token()));
            row.put("started_at", a.started());
            row.put("status", a.status());
            attemptsNode.add(row);
        }
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.put("log_version", "audit-run-log-v1");
        out.put("exported_at", AuditStore.now());
        out.set("hospital", hospitals().get(r.hospital()));
        out.set("run", runRow(r));
        out.set("documents", runDocuments(db, r));
        if (handoff == null) {
            out.putNull("human_intervention");
        } else {
            out.set("human_intervention", handoff);
        }
        if (origin == null) {
            out.putNull("imported_evidence_origin");
        } else {
            out.set("imported_evidence_origin", origin);
        }
        out.set("attempts", attemptsNode);
        out.set("timeline", timeline);
        out.set("receipt", AuditReceipt.publicReceipt(db, runRow(r)));
        ArrayNode limitations = Json.MAPPER.createArrayNode();
        limitations.add("Point-in-time export; an active run may produce more events after download.");
        limitations.add("Contains recorded task events, not a continuous worker heartbeat or model reasoning.");
        limitations.add("Legacy audit_failed events may lack a specific cause; this export does not infer missing diagnostics.");
        limitations.add("Raw exception text, document contents, credentials and local filesystem paths are excluded.");
        out.set("limitations", limitations);
        return out;
    }

    // -- documents ----------------------------------------------------------

    /**
     * Port of {@code runDocuments(db, r)}: the run's collected documents, from
     * its publication when present, else from the latest recorded collection.
     */
    public ObjectNode runDocuments(Connection db, RunData r) throws SQLException {
        JsonNode collection = null;
        JsonNode inventory = null;
        if (r.assessmentId() != null) {
            try (PreparedStatement ps = db.prepareStatement(
                    "SELECT json_extract(output,'$.discovery.documents') docs, "
                            + "json_extract(output,'$.inventory.sources') sources FROM assessments WHERE job=?")) {
                ps.setLong(1, r.id());
                try (ResultSet rs = ps.executeQuery()) {
                    if (rs.next()) {
                        String docs = rs.getString("docs");
                        String sources = rs.getString("sources");
                        if (docs != null) {
                            ObjectNode c = Json.MAPPER.createObjectNode();
                            c.set("documents", parseOrNull(docs));
                            collection = c;
                        }
                        if (sources != null) {
                            inventory = parseOrNull(sources);
                        }
                    }
                }
            }
        } else if (r.scanId() != null) {
            try {
                JsonNode scan = Json.MAPPER.readTree(
                        store.readArtifact("pipeline-scans/" + r.scanId() + ".json"));
                collection = scan.path("discovery");
                inventory = scan.path("inventory").path("sources");
                if (inventory.isMissingNode()) {
                    inventory = null;
                }
            } catch (IOException e) {
                throw AuditException.fail(500, "report_unavailable");
            }
        }
        ArrayNode attempts;
        if (collection != null) {
            attempts = AuditDiagnostics.documentAttempts(collection);
        } else {
            String docs = null;
            try (PreparedStatement ps = db.prepareStatement(
                    "SELECT json_extract(detail,'$.document_attempts') docs FROM audit_run_events "
                            + "WHERE job=? AND attempt=(SELECT token FROM jobs WHERE id=?) "
                            + "AND json_type(detail,'$.document_attempts')='array' "
                            + "ORDER BY seq DESC LIMIT 1")) {
                ps.setLong(1, r.id());
                ps.setLong(2, r.id());
                try (ResultSet rs = ps.executeQuery()) {
                    if (rs.next()) {
                        docs = rs.getString("docs");
                    }
                }
            }
            if (docs == null) {
                return null;
            }
            ObjectNode c = Json.MAPPER.createObjectNode();
            c.set("documents", parseOrNull(docs));
            attempts = AuditDiagnostics.documentAttempts(c);
        }
        int captured = 0;
        for (JsonNode d : attempts) {
            if ("saved".equals(Json.text(d, "status"))) {
                captured++;
            }
        }
        Integer applicable = null;
        if (inventory != null && inventory.isArray()) {
            int count = 0;
            for (JsonNode s : inventory) {
                String artifact = Json.text(s, "artifact_path");
                if (!"saved".equals(Json.text(s, "capture_status")) || artifact == null
                        || !(artifact.endsWith(".pdf") || artifact.endsWith(".docx"))
                        || !"applicable".equals(Json.text(s, "campus_applicability"))) {
                    continue;
                }
                String role = Json.text(s, "role");
                if ("application".equals(role) || "policy_summary".equals(role)
                        || "policy_statement".equals(role) || "supplement".equals(role)) {
                    count++;
                }
            }
            applicable = count;
        }
        Map<String, String> byDigest = new LinkedHashMap<>();
        if (inventory != null && inventory.isArray()) {
            for (JsonNode s : inventory) {
                if (s.has("text_status")) {
                    byDigest.put(Json.text(s, "digest"), Json.text(s, "text_status"));
                }
            }
        }
        for (JsonNode d : attempts) {
            String sha = Json.text(d, "sha256");
            String textStatus = sha == null ? null : byDigest.get(sha);
            if (textStatus == null) {
                ((ObjectNode) d).putNull("text_status");
            } else {
                ((ObjectNode) d).put("text_status", textStatus);
            }
        }
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.put("candidates", attempts.size());
        out.put("captured", captured);
        if (applicable == null) {
            out.putNull("classified_assistance_documents");
        } else {
            out.put("classified_assistance_documents", applicable);
        }
        out.set("attempts", attempts);
        return out;
    }

    // -- revision -----------------------------------------------------------

    private static List<String> gapTypes(JsonNode gaps) {
        Set<String> out = new LinkedHashSet<>();
        if (gaps != null && gaps.isArray()) {
            for (JsonNode g : gaps) {
                String s = g.asText();
                String lower = s.toLowerCase();
                if (lower.matches("(?s).*(campus|classif).*")) {
                    out.add("campus");
                } else if (lower.matches("(?s).*(language|translation).*")) {
                    out.add("language");
                } else if (lower.contains("template")) {
                    out.add("template");
                } else if (lower.matches("(?s).*(governing|reference).*")) {
                    out.add("reference");
                } else if (lower.matches("(?s).*(unavailable|not captured|404|410|snapshot).*")) {
                    out.add("missing");
                } else {
                    out.add("scope");
                }
            }
        }
        return new ArrayList<>(out);
    }

    /** The revision payload without the paged sources slice. */
    public ObjectNode revision(Connection db, RunData r, String id) throws SQLException {
        if (!id.equals(r.assessmentId()) && !id.equals(r.scanId())) {
            throw AuditException.fail(404, "unknown_revision");
        }
        String snapshotPath = BASE + "/runs/" + runId(r.id()) + "/revision/" + id + "/snapshots/";
        if (id.equals(r.assessmentId())) {
            JsonNode bundle;
            try (PreparedStatement ps = db.prepareStatement(
                    "SELECT output FROM assessments WHERE job=?")) {
                ps.setLong(1, r.id());
                try (ResultSet rs = ps.executeQuery()) {
                    if (!rs.next()) {
                        throw AuditException.fail(404, "unknown_revision");
                    }
                    bundle = Json.MAPPER.readTree(rs.getString("output"));
                } catch (IOException e) {
                    throw AuditException.fail(422, "revision_integrity");
                }
            }
            ObjectNode fingerprintInput = Json.MAPPER.createObjectNode();
            fingerprintInput.set("input", bundle.path("input"));
            fingerprintInput.set("report", bundle.path("report"));
            if (!Json.fingerprint(fingerprintInput).equals(id)) {
                throw AuditException.fail(422, "revision_integrity");
            }
            JsonNode review = bundle.path("agent_review");
            boolean hasReview = !review.isMissingNode() && !review.isNull();
            JsonNode inventory = bundle.path("inventory");
            String inventoryReviewHash = Json.text(inventory, "agent_review_sha256");
            if ((hasReview || inventoryReviewHash != null)
                    && (!Json.fingerprint(hasReview ? review : Json.MAPPER.nullNode())
                            .equals(inventoryReviewHash == null ? "" : inventoryReviewHash)
                    || !Json.fingerprint(inventory)
                            .equals(Json.text(bundle.path("input").path("scope"), "inventory_sha256")))) {
                throw AuditException.fail(422, "review_integrity");
            }
            ObjectNode out = Json.MAPPER.createObjectNode();
            out.put("revision", id);
            if (hasReview) {
                out.set("agent_review", PipelineViews.agentReview((ObjectNode) bundle, r.id()));
            }
            int sourceCount = 0;
            for (JsonNode s : bundle.path("input").path("sources")) {
                if (!s.path("snapshot").isMissingNode() && !s.path("snapshot").isNull()) {
                    sourceCount++;
                }
            }
            out.put("source_count", sourceCount);
            ArrayNode gaps = Json.MAPPER.createArrayNode();
            for (String g : gapTypes(bundle.path("report").path("coverage_gaps"))) {
                gaps.add(g);
            }
            out.set("gap_types", gaps);
            ArrayNode findings = Json.MAPPER.createArrayNode();
            for (JsonNode f : bundle.path("report").path("findings")) {
                ObjectNode row = Json.MAPPER.createObjectNode();
                row.put("measure_id", Json.text(f, "measure_id"));
                row.put("result", Json.text(f, "result"));
                findings.add(row);
            }
            out.set("findings", findings);
            ArrayNode sources = Json.MAPPER.createArrayNode();
            for (JsonNode s : bundle.path("input").path("sources")) {
                ObjectNode row = Json.MAPPER.createObjectNode();
                row.put("role", Json.text(s, "role"));
                row.put("language", Json.text(s, "language"));
                JsonNode snap = s.path("snapshot");
                if (snap.isMissingNode() || snap.isNull()) {
                    row.putNull("sha256");
                    row.putNull("download");
                } else {
                    row.put("sha256", Json.text(snap, "sha256"));
                    row.put("download", snapshotPath + Json.text(snap, "sha256"));
                }
                sources.add(row);
            }
            out.set("sources", sources);
            return out;
        }
        // scan revision
        JsonNode scanDoc;
        try {
            scanDoc = Json.MAPPER.readTree(store.readArtifact("pipeline-scans/" + id + ".json"));
        } catch (IOException e) {
            throw AuditException.fail(422, "revision_integrity");
        }
        String saved = Json.text(scanDoc, "id");
        ObjectNode scan = (ObjectNode) scanDoc.deepCopy();
        scan.remove("id");
        if (!id.equals(saved) || scan.path("job").asLong(-1) != r.id()
                || !Json.fingerprint(scan).equals(id)) {
            throw AuditException.fail(422, "revision_integrity");
        }
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.put("revision", id);
        int sourceCount = 0;
        for (JsonNode s : scan.path("inventory").path("sources")) {
            if ("saved".equals(Json.text(s, "capture_status"))) {
                sourceCount++;
            }
        }
        out.put("source_count", sourceCount);
        ArrayNode gaps = Json.MAPPER.createArrayNode();
        for (String g : gapTypes(scan.path("inventory").path("gaps"))) {
            gaps.add(g);
        }
        out.set("gap_types", gaps);
        ArrayNode sources = Json.MAPPER.createArrayNode();
        for (JsonNode s : scan.path("inventory").path("sources")) {
            ObjectNode row = Json.MAPPER.createObjectNode();
            row.put("role", Json.text(s, "role"));
            row.put("language", Json.text(s, "language"));
            row.put("sha256", Json.text(s, "digest"));
            row.put("availability", Json.text(s, "capture_status"));
            if ("saved".equals(Json.text(s, "capture_status"))) {
                row.put("download", snapshotPath + Json.text(s, "digest"));
            } else {
                row.putNull("download");
            }
            sources.add(row);
        }
        out.set("sources", sources);
        return out;
    }

    /** The snapshot attachment for a revision: raw bytes + filename. */
    public SnapshotBytes revisionSnapshot(Connection db, RunData r, String id, String digest)
            throws SQLException {
        if (!id.equals(r.assessmentId()) && !id.equals(r.scanId())) {
            throw AuditException.fail(404, "unknown_revision");
        }
        List<SnapshotSource> sources = new ArrayList<>();
        if (id.equals(r.assessmentId())) {
            JsonNode bundle;
            try (PreparedStatement ps = db.prepareStatement(
                    "SELECT output FROM assessments WHERE job=?")) {
                ps.setLong(1, r.id());
                try (ResultSet rs = ps.executeQuery()) {
                    if (!rs.next()) {
                        throw AuditException.fail(404, "unknown_revision");
                    }
                    bundle = Json.MAPPER.readTree(rs.getString("output"));
                } catch (IOException e) {
                    throw AuditException.fail(422, "revision_integrity");
                }
            }
            ObjectNode fingerprintInput = Json.MAPPER.createObjectNode();
            fingerprintInput.set("input", bundle.path("input"));
            fingerprintInput.set("report", bundle.path("report"));
            if (!Json.fingerprint(fingerprintInput).equals(id)) {
                throw AuditException.fail(422, "revision_integrity");
            }
            for (JsonNode s : bundle.path("input").path("sources")) {
                JsonNode snap = s.path("snapshot");
                if (!snap.isMissingNode() && !snap.isNull()) {
                    sources.add(new SnapshotSource(Json.text(snap, "sha256"),
                            Json.text(snap, "artifact_path")));
                }
            }
        } else {
            JsonNode scanDoc;
            try {
                scanDoc = Json.MAPPER.readTree(store.readArtifact("pipeline-scans/" + id + ".json"));
            } catch (IOException e) {
                throw AuditException.fail(422, "revision_integrity");
            }
            String saved = Json.text(scanDoc, "id");
            ObjectNode scan = (ObjectNode) scanDoc.deepCopy();
            scan.remove("id");
            if (!id.equals(saved) || scan.path("job").asLong(-1) != r.id()
                    || !Json.fingerprint(scan).equals(id)) {
                throw AuditException.fail(422, "revision_integrity");
            }
            for (JsonNode s : scan.path("inventory").path("sources")) {
                if ("saved".equals(Json.text(s, "capture_status"))) {
                    sources.add(new SnapshotSource(Json.text(s, "digest"),
                            Json.text(s, "artifact_path")));
                }
            }
        }
        return attachment(sources, digest);
    }

    private record SnapshotSource(String sha256, String artifactPath) {
    }

    public record SnapshotBytes(byte[] bytes, String filename) {
    }

    /** Port of {@code attachment(sources, digest)}: sha-verified snapshot bytes. */
    public SnapshotBytes attachment(List<SnapshotSource> sources, String digest) {
        SnapshotSource found = null;
        for (SnapshotSource s : sources) {
            if (digest.equals(s.sha256())) {
                for (String ext : new String[]{"pdf", "docx", "html", "json"}) {
                    if (("snapshots/" + digest + "." + ext).equals(s.artifactPath())) {
                        found = s;
                        break;
                    }
                }
            }
            if (found != null) {
                break;
            }
        }
        if (found == null) {
            throw AuditException.fail(404, "unknown_snapshot");
        }
        byte[] bytes;
        try {
            bytes = store.readArtifact(found.artifactPath());
        } catch (IOException e) {
            throw AuditException.fail(404, "snapshot_unavailable");
        }
        if (!Json.sha256Hex(bytes).equals(digest)) {
            throw AuditException.fail(422, "snapshot_integrity");
        }
        String filename = found.artifactPath().substring(found.artifactPath().lastIndexOf('/') + 1);
        return new SnapshotBytes(bytes, filename);
    }

    // -- summary / operations -----------------------------------------------

    /** GET /summary — the response body without schema_version. */
    public ObjectNode summary(Connection db, Map<String, String> q) throws SQLException {
        params(q, "pfi", "region", "mode", "status", "evidence", "from", "to");
        if ((q.containsKey("region") && !regions().contains(q.get("region")))
                || (q.containsKey("pfi") && !hospitals().containsKey(q.get("pfi")))
                || (q.containsKey("mode") && !MODES.contains(q.get("mode")))
                || (q.containsKey("status") && !STATUSES.contains(q.get("status")))
                || (q.containsKey("evidence")
                && !List.of("partial", "complete", "unknown").contains(q.get("evidence")))) {
            throw AuditException.fail(400, "invalid_filter");
        }
        for (String d : new String[]{q.get("from"), q.get("to")}) {
            if (d != null && (!d.matches("^\\d{4}-\\d{2}-\\d{2}$") || !validCalendarDate(d))) {
                throw AuditException.fail(400, "invalid_date");
            }
        }
        if (q.get("from") != null && q.get("to") != null && q.get("from").compareTo(q.get("to")) > 0) {
            throw AuditException.fail(400, "invalid_date");
        }
        Set<String> selected = new LinkedHashSet<>();
        for (ObjectNode h : hospitals().values()) {
            if ((q.get("region") == null || q.get("region").equals(Json.text(h, "region")))
                    && (q.get("pfi") == null || q.get("pfi").equals(Json.text(h, "hospital_key")))) {
                selected.add(Json.text(h, "hospital_key"));
            }
        }
        ObjectNode result = Json.MAPPER.createObjectNode();
        result.put("roster_total", hospitals().size());
        result.put("eligible_facilities", selected.size());
        result.put("facilities_with_runs", 0);
        result.put("runs", 0);
        result.set("by_status", Json.MAPPER.createObjectNode());
        result.put("incomplete_receipts", 0);
        result.putNull("known_billed_usd");
        result.putNull("estimated_local_usd");
        result.putNull("calculated_provider_usd");
        result.set("billed_by_currency", Json.MAPPER.createObjectNode());
        result.set("units", Json.MAPPER.createObjectNode());
        if (db == null) {
            return result;
        }
        Set<String> covered = new LinkedHashSet<>();
        List<RunData> rows = queryRuns(db, "SELECT * FROM (" + PROJECTION + ")",
                store.pipelineRoot().toString());
        int runs = 0;
        int incomplete = 0;
        double known = 0, estimated = 0, calculated = 0;
        boolean hasKnown = false, hasEstimated = false, hasCalculated = false;
        ObjectNode byStatus = (ObjectNode) result.path("by_status");
        ObjectNode billedByCurrency = (ObjectNode) result.path("billed_by_currency");
        ObjectNode units = (ObjectNode) result.path("units");
        for (RunData r : rows) {
            String day = r.queuedAt() == null ? null : r.queuedAt().substring(0, 10);
            if (!selected.contains(r.hospital())
                    || (q.get("mode") != null && !q.get("mode").equals(r.mode()))
                    || (q.get("status") != null && !q.get("status").equals(r.status()))
                    || (q.get("evidence") != null
                    && !q.get("evidence").equals(runRow(r).path("evidence").asText()))
                    || (q.get("from") != null && (day == null || day.compareTo(q.get("from")) < 0))
                    || (q.get("to") != null && (day == null || day.compareTo(q.get("to")) > 0))) {
                continue;
            }
            ObjectNode receipt = AuditReceipt.publicReceipt(db, runRow(r));
            covered.add(r.hospital());
            runs++;
            byStatus.put(r.status(), byStatus.path(r.status()).asInt(0) + 1);
            if (!receipt.path("complete").asBoolean(false)) {
                incomplete++;
            }
            if (!receipt.path("known_billed_usd").isNull()) {
                known += receipt.path("known_billed_usd").asDouble();
                hasKnown = true;
            }
            if (!receipt.path("estimated_local_usd").isNull()) {
                estimated += receipt.path("estimated_local_usd").asDouble();
                hasEstimated = true;
            }
            if (!receipt.path("calculated_provider_usd").isNull()) {
                calculated += receipt.path("calculated_provider_usd").asDouble();
                hasCalculated = true;
            }
            for (Map.Entry<String, JsonNode> e : Json.fields(receipt.path("units"))) {
                units.put(e.getKey(), units.path(e.getKey()).asLong(0) + e.getValue().asLong());
            }
            for (Map.Entry<String, JsonNode> e : Json.fields(receipt.path("billed_by_currency"))) {
                billedByCurrency.put(e.getKey(),
                        billedByCurrency.path(e.getKey()).asDouble(0) + e.getValue().asDouble());
            }
        }
        result.put("facilities_with_runs", covered.size());
        result.put("runs", runs);
        result.put("incomplete_receipts", incomplete);
        if (hasKnown) {
            result.put("known_billed_usd", known);
        }
        if (hasEstimated) {
            result.put("estimated_local_usd", estimated);
        }
        if (hasCalculated) {
            result.put("calculated_provider_usd", calculated);
        }
        return result;
    }

    private Set<String> regions() {
        Set<String> out = new LinkedHashSet<>();
        try {
            JsonNode regions = Json.readFile(paths.referencesDir().resolve("ny-economic-regions-v1.json"))
                    .path("regions");
            regions.fieldNames().forEachRemaining(out::add);
        } catch (IOException e) {
            throw new IllegalStateException("Could not load regions", e);
        }
        return out;
    }

    /** Mirrors the JS date check: YYYY-MM-DD that parses and round-trips. */
    private static boolean validCalendarDate(String d) {
        try {
            java.time.LocalDate date = java.time.LocalDate.parse(d);
            return date.toString().equals(d);
        } catch (Exception e) {
            return false;
        }
    }

    /** GET /operations — one row per roster facility, latest run first. */
    public ObjectNode operations(Connection db) throws SQLException {
        Map<String, RunData> latest = new LinkedHashMap<>();
        if (db != null) {
            String sql = "SELECT * FROM (SELECT p.*, row_number() OVER (PARTITION BY hospital ORDER BY id DESC) "
                    + "AS rank FROM (" + PROJECTION + ") p) WHERE rank=1";
            List<RunData> rows = queryRuns(db, sql, store.pipelineRoot().toString());
            for (RunData r : rows) {
                latest.put(r.hospital(), r);
            }
        }
        ArrayNode items = Json.MAPPER.createArrayNode();
        for (ObjectNode h : hospitals().values()) {
            String key = Json.text(h, "hospital_key");
            RunData r = latest.get(key);
            ObjectNode row = h.deepCopy();
            row.set("clocks", clocks(r == null ? null : db, key));
            if (r == null) {
                row.putNull("latest");
                row.put("cost_status", "unknown");
            } else {
                row.set("latest", runRow(r));
                row.put("cost_status", AuditReceipt.publicReceipt(db, runRow(r)).path("cost_status").asText());
            }
            items.add(row);
        }
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.set("items", items);
        return out;
    }

    // -- interventions ------------------------------------------------------

    /**
     * Port of {@code interventionFor(db, job)} (interventions.js). Returns
     * null when the run has no website-verification event.
     */
    public ObjectNode interventionFor(Connection db, long jobId, String hospitalKey) throws SQLException {
        String detailJson = null;
        String blockedAt = null;
        try (PreparedStatement ps = db.prepareStatement(
                "SELECT detail,at FROM audit_run_events WHERE job=? "
                        + "AND json_extract(detail,'$.error_code')='website_verification_required' "
                        + "ORDER BY seq DESC LIMIT 1")) {
            ps.setLong(1, jobId);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    return null;
                }
                detailJson = rs.getString("detail");
                blockedAt = rs.getString("at");
            }
        }
        String resumedJson = null;
        try (PreparedStatement ps = db.prepareStatement(
                "SELECT detail FROM audit_run_events WHERE job=? AND state='human_resumed' "
                        + "ORDER BY seq DESC LIMIT 1")) {
            ps.setLong(1, jobId);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    resumedJson = rs.getString("detail");
                }
            }
        }
        List<JsonNode> docs = new ArrayList<>();
        try (PreparedStatement ps = db.prepareStatement(
                "SELECT detail FROM audit_run_events WHERE job=? AND state='human_document_imported' "
                        + "ORDER BY seq")) {
            ps.setLong(1, jobId);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    docs.add(Json.MAPPER.readTree(rs.getString("detail")));
                }
            } catch (IOException e) {
                throw new SQLException(e);
            }
        }
        JsonNode detail;
        try {
            detail = Json.MAPPER.readTree(detailJson);
        } catch (IOException e) {
            throw new SQLException(e);
        }
        ObjectNode diag = AuditDiagnostics.failureDiagnostic("website_verification_required",
                detail.path("diagnostic"));
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.put("audit_run_id", runId(jobId));
        out.put("hospital_key", hospitalKey);
        ObjectNode hospital = hospitals().get(hospitalKey);
        out.put("hospital_name", hospital == null ? "Hospital " + hospitalKey
                : Json.text(hospital, "name"));
        out.put("status", resumedJson != null ? "resumed" : "needs_human");
        out.put("blocked_at", blockedAt);
        if (diag == null || diag.path("source_url").isNull()) {
            out.putNull("source_url");
        } else {
            out.put("source_url", diag.path("source_url").asText());
        }
        ArrayNode docsNode = Json.MAPPER.createArrayNode();
        for (JsonNode d : docs) {
            docsNode.add(d);
        }
        out.set("documents", docsNode);
        if (resumedJson == null) {
            out.putNull("resumed_run_id");
        } else {
            try {
                out.put("resumed_run_id",
                        Json.MAPPER.readTree(resumedJson).path("audit_run_id").asText(null));
            } catch (IOException e) {
                throw new SQLException(e);
            }
        }
        return out;
    }

    /** GET /interventions — only items still needing a human, newest job first. */
    public ArrayNode interventions(Connection db) throws SQLException {
        ArrayNode out = Json.MAPPER.createArrayNode();
        try (PreparedStatement ps = db.prepareStatement(
                "SELECT id,hospital FROM jobs WHERE rule='css-17-v1' AND json_extract(context,'$.root')=? "
                        + "AND EXISTS(SELECT 1 FROM audit_run_events e WHERE e.job=jobs.id "
                        + "AND json_extract(e.detail,'$.error_code')='website_verification_required') "
                        + "ORDER BY id DESC")) {
            ps.setString(1, store.pipelineRoot().toString());
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode item = interventionFor(db, rs.getLong("id"), rs.getString("hospital"));
                    if (item != null && "needs_human".equals(Json.text(item, "status"))) {
                        out.add(item);
                    }
                }
            }
        }
        return out;
    }

    /** The jobs row (id, hospital, year, review_date, rule, context) for a run. */
    public ObjectNode jobRow(Connection db, long id) throws SQLException {
        try (PreparedStatement ps = db.prepareStatement(
                "SELECT * FROM jobs WHERE id=? AND rule='css-17-v1' "
                        + "AND json_extract(context,'$.root')=?")) {
            ps.setLong(1, id);
            ps.setString(2, store.pipelineRoot().toString());
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    return null;
                }
                ObjectNode out = Json.MAPPER.createObjectNode();
                out.put("id", rs.getLong("id"));
                out.put("hospital", rs.getString("hospital"));
                out.put("year", rs.getInt("year"));
                out.put("review_date", rs.getString("review_date"));
                out.put("rule", rs.getString("rule"));
                out.put("status", rs.getString("status"));
                try {
                    out.set("context", Json.MAPPER.readTree(rs.getString("context")));
                } catch (IOException e) {
                    throw new SQLException(e);
                }
                return out;
            }
        }
    }

    /**
     * Port of {@code publications(root)} (pipeline-store.js): committed
     * publications only. Never creates a database on a read path. Returns
     * {bundles, failures, events, jobs}; throws IOException on a persisted
     * assessment identity mismatch, exactly like the old code.
     */
    public ObjectNode publications() throws SQLException, IOException {
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.set("bundles", Json.MAPPER.createArrayNode());
        out.set("failures", Json.MAPPER.createArrayNode());
        out.set("events", Json.MAPPER.createArrayNode());
        out.set("jobs", Json.MAPPER.createArrayNode());
        java.nio.file.Path dbPath = store.dbPath();
        if (!java.nio.file.Files.exists(dbPath)) {
            return out;
        }
        boolean includeSynthetic = "1".equals(System.getenv("T2P_PILOT_DEMO"));
        String root = store.pipelineRoot().toString();
        try (Connection db = store.openReadOnly()) {
            if (db == null || !AuditStore.hasTable(db, "pipeline_events")) {
                return out;
            }
            List<ObjectNode> bundles = new ArrayList<>();
            try (PreparedStatement ps = db.prepareStatement(
                    "SELECT a.output,a.job FROM assessments a JOIN jobs j ON j.id=a.job "
                            + "WHERE j.rule='css-17-v1' ORDER BY a.job DESC")) {
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) {
                        ObjectNode b = (ObjectNode) Json.MAPPER.readTree(rs.getString("output"));
                        b.put("job", rs.getLong("job"));
                        bundles.add(b);
                    }
                }
            }
            List<ObjectNode> kept = new ArrayList<>();
            for (ObjectNode b : bundles) {
                if (!root.equals(Json.text(b, "root"))) {
                    continue;
                }
                boolean synthetic = b.path("input").path("synthetic").asBoolean(false);
                if (!includeSynthetic && synthetic) {
                    continue;
                }
                ObjectNode fingerprintInput = Json.MAPPER.createObjectNode();
                fingerprintInput.set("input", b.path("input"));
                fingerprintInput.set("report", b.path("report"));
                JsonNode inventory = b.path("inventory");
                String agentReviewHash = Json.text(inventory, "agent_review_sha256");
                boolean reviewMismatch = (b.has("agent_review") || agentReviewHash != null)
                        && (!Json.fingerprint(b.has("agent_review") ? b.path("agent_review")
                                : Json.MAPPER.nullNode()).equals(agentReviewHash == null ? "" : agentReviewHash));
                boolean inventoryMismatch = Json.text(b.path("input").path("scope"), "inventory_sha256") != null
                        && !Json.fingerprint(inventory).equals(
                                Json.text(b.path("input").path("scope"), "inventory_sha256"));
                if (!Json.fingerprint(fingerprintInput).equals(Json.text(b, "id"))
                        || reviewMismatch || inventoryMismatch) {
                    throw new IOException("Persisted assessment identity mismatch");
                }
                kept.add(b);
            }
            List<ObjectNode> jobs = new ArrayList<>();
            try (PreparedStatement ps = db.prepareStatement(
                    "SELECT * FROM jobs WHERE rule='css-17-v1' ORDER BY id DESC")) {
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) {
                        ObjectNode j = Json.MAPPER.createObjectNode();
                        j.put("id", rs.getLong("id"));
                        j.put("hospital", rs.getString("hospital"));
                        j.put("year", rs.getInt("year"));
                        j.put("rule", rs.getString("rule"));
                        j.put("review_date", rs.getString("review_date"));
                        j.set("context", Json.MAPPER.readTree(rs.getString("context")));
                        j.put("status", rs.getString("status"));
                        j.put("token", rs.getString("token"));
                        j.put("attempted", rs.getString("attempted"));
                        j.put("attempts", rs.getInt("attempts"));
                        j.put("error", rs.getString("error"));
                        String checkpoint = rs.getString("checkpoint");
                        if (checkpoint == null) {
                            j.putNull("checkpoint");
                        } else {
                            j.put("checkpoint", checkpoint);
                        }
                        if (!root.equals(Json.text(j.path("context"), "root"))) {
                            continue;
                        }
                        if (!includeSynthetic
                                && "synthetic".equals(Json.text(j.path("context"), "mode"))) {
                            continue;
                        }
                        jobs.add(j);
                    }
                }
            }
            ArrayNode failures = Json.MAPPER.createArrayNode();
            for (ObjectNode j : jobs) {
                if (Json.text(j, "error") != null
                        && !"discovery_only".equals(Json.text(j.path("context"), "mode"))) {
                    failures.add(j);
                }
            }
            java.util.Set<Long> bundleJobs = new java.util.HashSet<>();
            for (ObjectNode b : kept) {
                bundleJobs.add(b.path("job").asLong());
            }
            ArrayNode events = Json.MAPPER.createArrayNode();
            try (PreparedStatement ps = db.prepareStatement(
                    "SELECT job,output FROM pipeline_events ORDER BY job DESC")) {
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) {
                        if (bundleJobs.contains(rs.getLong("job"))) {
                            events.add(Json.MAPPER.readTree(rs.getString("output")));
                        }
                    }
                }
            }
            ArrayNode bundlesNode = Json.MAPPER.createArrayNode();
            for (ObjectNode b : kept) {
                bundlesNode.add(b);
            }
            ArrayNode jobsNode = Json.MAPPER.createArrayNode();
            for (ObjectNode j : jobs) {
                jobsNode.add(j);
            }
            out.set("bundles", bundlesNode);
            out.set("failures", failures);
            out.set("events", events);
            out.set("jobs", jobsNode);
            return out;
        }
    }
}
