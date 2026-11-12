package com.truth2power.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.truth2power.service.AuditBudgets;
import com.truth2power.service.AuditEnqueueService;
import com.truth2power.service.AuditException;
import com.truth2power.service.AuditReceipt;
import com.truth2power.service.AuditRunService;
import com.truth2power.service.AuditStore;
import com.truth2power.service.Json;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The v1 reporting API — port of backend/audit/reporting-api.js plus
 * backend/audit/interventions.js.
 *
 * <p>Every response (success and error) carries
 * {@code "schema_version": "audit-reporting-v1"} except the intervention
 * routes, whose separate helper has no schema_version — exactly like the
 * old code. Error bodies are machine codes, not sentences. All JSON
 * responses carry {@code Cache-Control: no-store}.
 *
 * <p>Routing order mirrors reportingRoute: interventions are checked before
 * the other v1 routes; a POST to a matched facility path enqueues; any other
 * non-GET method is 405 {@code method_not_allowed}; any other GET path is
 * 404 {@code unknown_endpoint}.
 */
@RestController
@RequestMapping("/api/pilot/v1")
public class PilotReportingController {

    private static final Logger log = LoggerFactory.getLogger(PilotReportingController.class);

    private static final List<String> MODES = List.of("replay", "full_audit", "live", "discovery_only");
    private static final Pattern REQUEST_KEY = Pattern.compile("^[A-Za-z0-9-]{1,100}$");
    private static final Pattern RETRIEVED_AT =
            Pattern.compile("^\\d{4}-\\d\\d-\\d\\dT.*(?:Z|[+-]\\d\\d:\\d\\d)$");
    private static final Pattern BASE64 = Pattern.compile("^[A-Za-z0-9+/]*={0,2}$");
    private static final int MAX_BODY = 8192;
    private static final int MAX_DOCUMENT_BODY = 6 * 1024 * 1024;

    private final AuditStore store;
    private final AuditRunService runs;
    private final AuditEnqueueService enqueue;

    public PilotReportingController(AuditStore store, AuditRunService runs, AuditEnqueueService enqueue) {
        this.store = store;
        this.runs = runs;
        this.enqueue = enqueue;
    }

    // -- envelope helpers ---------------------------------------------------

    private static ResponseEntity<String> v1(int status, ObjectNode body) {
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.put("schema_version", AuditRunService.VERSION);
        out.setAll(body);
        return ResponseEntity.status(status)
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .contentType(MediaType.APPLICATION_JSON)
                .body(Json.stringify(out));
    }

    private static ResponseEntity<String> v1Error(AuditException e) {
        ObjectNode body = Json.MAPPER.createObjectNode();
        body.put("error", e.code);
        return v1(e.status, body);
    }

    /** The intervention envelope: no schema_version, default status 400. */
    private static ResponseEntity<String> interventionError(AuditException e) {
        ObjectNode body = Json.MAPPER.createObjectNode();
        body.put("error", e.code);
        return ResponseEntity.status(e.status)
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .contentType(MediaType.APPLICATION_JSON)
                .body(Json.stringify(body));
    }

    private static ResponseEntity<String> interventionOk(int status, ObjectNode body) {
        return ResponseEntity.status(status)
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .contentType(MediaType.APPLICATION_JSON)
                .body(Json.stringify(body));
    }

    /** Read-only reporting open + the migration_required check. */
    private Connection openReporting() throws SQLException {
        Connection db = store.openReadOnly();
        if (db != null) {
            if (!AuditStore.hasTable(db, "audit_run_events")) {
                try {
                    db.close();
                } catch (SQLException ignored) {
                    // keep the 503
                }
                throw AuditException.fail(503, "migration_required");
            }
            AuditStore.ensureTempLedgerTables(db);
        }
        return db;
    }

    private static void closeQuietly(Connection db) {
        if (db != null) {
            try {
                db.close();
            } catch (SQLException ignored) {
                // reporting is done
            }
        }
    }

    /**
     * Query parameters from the URL query string ONLY. (HttpServletRequest's
     * parameter map also merges a form-encoded POST body into the parameters,
     * which the old handler never saw — its query came from the URL alone.)
     */
    private static Map<String, String> queryParams(HttpServletRequest request) {
        Map<String, String> out = new java.util.LinkedHashMap<>();
        String qs = request.getQueryString();
        if (qs == null || qs.isEmpty()) {
            return out;
        }
        for (String pair : qs.split("&")) {
            int eq = pair.indexOf('=');
            String k = eq < 0 ? pair : pair.substring(0, eq);
            String v = eq < 0 ? "" : pair.substring(eq + 1);
            try {
                out.put(java.net.URLDecoder.decode(k, java.nio.charset.StandardCharsets.UTF_8),
                        java.net.URLDecoder.decode(v, java.nio.charset.StandardCharsets.UTF_8));
            } catch (IllegalArgumentException ignored) {
                // malformed percent-encoding: keep the raw pair
                out.put(k, v);
            }
        }
        return out;
    }

    // -- queue a run --------------------------------------------------------

    @PostMapping("/hospitals/{key}/runs")
    public ResponseEntity<String> queueRun(@PathVariable("key") String key,
                                           HttpServletRequest request) throws IOException {
        Map<String, String> q = queryParams(request);
        try {
            if (!runs.hospitals().containsKey(key)) {
                throw AuditException.fail(404, "unknown_hospital");
            }
            AuditRunService.params(q);
            if (!"1".equals(request.getHeader("x-review-request"))) {
                throw AuditException.fail(403, "forbidden");
            }
            byte[] raw = request.getInputStream().readAllBytes();
            if (raw.length > MAX_BODY) {
                throw AuditException.fail(413, "body_too_large");
            }
            JsonNode parsed;
            try {
                parsed = Json.MAPPER.readTree(raw);
            } catch (Exception e) {
                throw AuditException.fail(400, "invalid_request");
            }
            if (!parsed.isObject()) {
                throw AuditException.fail(400, "invalid_request");
            }
            ObjectNode o = (ObjectNode) parsed;
            String mode = Json.text(o, "mode");
            String requestKey = Json.text(o, "request_key");
            if (!MODES.contains(mode) || requestKey == null || !REQUEST_KEY.matcher(requestKey).matches()
                    || !o.path("year").isIntegralNumber() || Json.text(o, "review_date") == null
                    || hasUnknownKey(o)) {
                throw AuditException.fail(400, "invalid_request");
            }
            JsonNode allowPaid = o.path("allow_paid");
            if (!allowPaid.isMissingNode()
                    && (!allowPaid.isBoolean() || !allowPaid.asBoolean()
                    || !"full_audit".equals(mode) || !o.has("review_config"))) {
                throw AuditException.fail(400, "invalid_paid_confirmation");
            }
            try (Connection db = store.openStore()) {
                long id = enqueue.enqueuePipeline(db, o, key);
                ObjectNode body = Json.MAPPER.createObjectNode();
                body.put("audit_run_id", AuditRunService.runId(id));
                body.put("url", AuditRunService.BASE + "/runs/" + AuditRunService.runId(id));
                return v1(202, body);
            } catch (IllegalArgumentException e) {
                String message = e.getMessage() == null ? "" : e.getMessage();
                if (message.contains("Idempotency key")
                        || message.contains("Review configuration changed")) {
                    throw AuditException.fail(409, "request_conflict");
                }
                if (message.contains("Invalid")) {
                    throw AuditException.fail(400, "invalid_request");
                }
                throw e;
            }
        } catch (AuditException e) {
            return v1Error(e);
        } catch (SQLException e) {
            return v1Error(AuditException.fail(500, "report_unavailable"));
        }
    }

    private static boolean hasUnknownKey(ObjectNode o) {
        java.util.Set<String> allowed = java.util.Set.of("year", "review_date", "mode", "request_key",
                "discovery_bounds", "budget", "allow_paid", "review_config");
        for (java.util.Iterator<String> it = o.fieldNames(); it.hasNext();) {
            if (!allowed.contains(it.next())) {
                return true;
            }
        }
        return false;
    }

    // -- facility runs ------------------------------------------------------

    @GetMapping("/hospitals/{key}/runs")
    public ResponseEntity<String> facilityRuns(@PathVariable("key") String key,
                                               HttpServletRequest request) {
        Map<String, String> q = queryParams(request);
        Connection db = null;
        try {
            if (!runs.hospitals().containsKey(key)) {
                throw AuditException.fail(404, "unknown_hospital");
            }
            db = openReporting();
            AuditRunService.params(q, "limit", "cursor");
            int limit = (int) AuditRunService.integer(q.getOrDefault("limit", "25"), 100);
            long cursor = q.containsKey("cursor")
                    ? AuditRunService.integer(q.get("cursor"), Long.MAX_VALUE)
                    : Long.MAX_VALUE;
            return v1(200, runs.facilityRuns(db, key, limit, cursor));
        } catch (AuditException e) {
            return v1Error(e);
        } catch (SQLException e) {
            return v1Error(AuditException.fail(500, "report_unavailable"));
        } finally {
            closeQuietly(db);
        }
    }

    // -- single run ---------------------------------------------------------

    private AuditRunService.RunData requireRun(Connection db, long id) throws SQLException {
        AuditRunService.RunData r = runs.findRun(db, id);
        if (r == null) {
            throw AuditException.fail(404, "unknown_run");
        }
        return r;
    }

    @GetMapping("/runs/audit-run-{id:[1-9][0-9]*}")
    public ResponseEntity<String> runDetail(@PathVariable("id") long id,
                                            HttpServletRequest request) {
        Connection db = null;
        try {
            db = openReporting();
            AuditRunService.params(queryParams(request));
            return v1(200, runs.runDetail(db, requireRun(db, id)));
        } catch (AuditException e) {
            return v1Error(e);
        } catch (SQLException e) {
            return v1Error(AuditException.fail(500, "report_unavailable"));
        } finally {
            closeQuietly(db);
        }
    }

    @GetMapping("/runs/audit-run-{id:[1-9][0-9]*}/timeline")
    public ResponseEntity<String> timeline(@PathVariable("id") long id,
                                           HttpServletRequest request) {
        Map<String, String> q = queryParams(request);
        Connection db = null;
        try {
            db = openReporting();
            AuditRunService.params(q, "limit", "cursor");
            int limit = (int) AuditRunService.integer(q.getOrDefault("limit", "25"), 100);
            long cursor = q.containsKey("cursor")
                    ? AuditRunService.integer(q.get("cursor"), Long.MAX_VALUE) : 0;
            AuditRunService.RunData r = requireRun(db, id);
            return v1(200, runs.timeline(db, r.id(), limit, cursor));
        } catch (AuditException e) {
            return v1Error(e);
        } catch (SQLException e) {
            log.warn("timeline failed for audit-run-{}", id, e);
            return v1Error(AuditException.fail(500, "report_unavailable"));
        } finally {
            closeQuietly(db);
        }
    }

    @GetMapping("/runs/audit-run-{id:[1-9][0-9]*}/log.json")
    public ResponseEntity<String> logJson(@PathVariable("id") long id,
                                          HttpServletRequest request) {
        Connection db = null;
        try {
            db = openReporting();
            AuditRunService.params(queryParams(request));
            AuditRunService.RunData r = requireRun(db, id);
            ObjectNode log = runs.logJson(db, r);
            ObjectNode body = Json.MAPPER.createObjectNode();
            body.put("schema_version", AuditRunService.VERSION);
            body.setAll(log);
            String pretty = Json.MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(body);
            return ResponseEntity.status(200)
                    .header(HttpHeaders.CACHE_CONTROL, "no-store")
                    .header(HttpHeaders.CONTENT_DISPOSITION,
                            "attachment; filename=\"audit-run-" + id + "-log.json\"")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(pretty);
        } catch (AuditException e) {
            return v1Error(e);
        } catch (SQLException | IOException e) {
            return v1Error(AuditException.fail(500, "report_unavailable"));
        } finally {
            closeQuietly(db);
        }
    }

    @GetMapping("/runs/audit-run-{id:[1-9][0-9]*}/receipt")
    public ResponseEntity<String> receipt(@PathVariable("id") long id,
                                          HttpServletRequest request) {
        Connection db = null;
        try {
            db = openReporting();
            AuditRunService.params(queryParams(request));
            AuditRunService.RunData r = requireRun(db, id);
            return v1(200, AuditReceipt.publicReceipt(db, AuditRunService.runRow(r)));
        } catch (AuditException e) {
            return v1Error(e);
        } catch (SQLException e) {
            return v1Error(AuditException.fail(500, "report_unavailable"));
        } finally {
            closeQuietly(db);
        }
    }

    @GetMapping("/runs/audit-run-{id:[1-9][0-9]*}/receipt.csv")
    public ResponseEntity<String> receiptCsv(@PathVariable("id") long id,
                                             HttpServletRequest request) {
        Connection db = null;
        try {
            db = openReporting();
            AuditRunService.params(queryParams(request));
            AuditRunService.RunData r = requireRun(db, id);
            ObjectNode receipt = AuditReceipt.publicReceipt(db, AuditRunService.runRow(r));
            ObjectNode withVersion = Json.MAPPER.createObjectNode();
            withVersion.put("schema_version", AuditRunService.VERSION);
            withVersion.setAll(receipt);
            return ResponseEntity.status(200)
                    .header(HttpHeaders.CACHE_CONTROL, "no-store")
                    .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"audit-receipt-v1.csv\"")
                    .contentType(MediaType.parseMediaType("text/csv; charset=utf-8"))
                    .body(AuditReceipt.csv(withVersion));
        } catch (AuditException e) {
            return v1Error(e);
        } catch (SQLException e) {
            return v1Error(AuditException.fail(500, "report_unavailable"));
        } finally {
            closeQuietly(db);
        }
    }

    @GetMapping("/runs/audit-run-{id:[1-9][0-9]*}/revision/{revision:[a-f0-9]{64}}")
    public ResponseEntity<String> revision(@PathVariable("id") long id,
                                           @PathVariable("revision") String revision,
                                           HttpServletRequest request) {
        Map<String, String> q = queryParams(request);
        Connection db = null;
        try {
            db = openReporting();
            AuditRunService.params(q, "limit", "cursor");
            int limit = (int) AuditRunService.integer(q.getOrDefault("limit", "25"), 100);
            long offset = q.containsKey("cursor")
                    ? AuditRunService.integer(q.get("cursor"), Long.MAX_VALUE) : 0;
            AuditRunService.RunData r = requireRun(db, id);
            ObjectNode result = runs.revision(db, r, revision);
            ArrayNode sources = (ArrayNode) result.path("sources");
            ArrayNode page = Json.MAPPER.createArrayNode();
            for (int i = (int) offset; i < Math.min(sources.size(), offset + limit); i++) {
                page.add(sources.get(i));
            }
            result.set("sources", page);
            if (sources.size() > offset + limit) {
                result.put("next_cursor", String.valueOf(offset + limit));
            } else {
                result.putNull("next_cursor");
            }
            return v1(200, result);
        } catch (AuditException e) {
            return v1Error(e);
        } catch (SQLException e) {
            return v1Error(AuditException.fail(500, "report_unavailable"));
        } finally {
            closeQuietly(db);
        }
    }

    @GetMapping("/runs/audit-run-{id:[1-9][0-9]*}/revision/{revision:[a-f0-9]{64}}/snapshots/{digest:[a-f0-9]{64}}")
    public ResponseEntity<byte[]> revisionSnapshot(@PathVariable("id") long id,
                                                   @PathVariable("revision") String revision,
                                                   @PathVariable("digest") String digest,
                                                   HttpServletRequest request) {
        Connection db = null;
        try {
            db = openReporting();
            AuditRunService.params(queryParams(request));
            AuditRunService.RunData r = requireRun(db, id);
            AuditRunService.SnapshotBytes snap = runs.revisionSnapshot(db, r, revision, digest);
            return ResponseEntity.status(200)
                    .header(HttpHeaders.CACHE_CONTROL, "no-store")
                    .header(HttpHeaders.CONTENT_DISPOSITION,
                            "attachment; filename=\"" + snap.filename() + "\"")
                    .header("Content-Security-Policy", "sandbox")
                    .header("X-Content-Type-Options", "nosniff")
                    .contentType(MediaType.APPLICATION_OCTET_STREAM)
                    .body(snap.bytes());
        } catch (AuditException e) {
            return snapshotError(e);
        } catch (SQLException e) {
            return snapshotError(AuditException.fail(500, "report_unavailable"));
        } finally {
            closeQuietly(db);
        }
    }

    /** Snapshot errors use the v1 JSON envelope (the old attachment() throws into it). */
    private ResponseEntity<byte[]> snapshotError(AuditException e) {
        ObjectNode body = Json.MAPPER.createObjectNode();
        body.put("schema_version", AuditRunService.VERSION);
        body.put("error", e.code);
        return ResponseEntity.status(e.status)
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .contentType(MediaType.APPLICATION_JSON)
                .body(Json.stringify(body).getBytes(StandardCharsets.UTF_8));
    }

    // -- summary / operations ----------------------------------------------

    @GetMapping("/summary")
    public ResponseEntity<String> summary(HttpServletRequest request) {
        Connection db = null;
        try {
            db = openReporting();
            return v1(200, runs.summary(db, queryParams(request)));
        } catch (AuditException e) {
            return v1Error(e);
        } catch (SQLException e) {
            return v1Error(AuditException.fail(500, "report_unavailable"));
        } finally {
            closeQuietly(db);
        }
    }

    @GetMapping("/operations")
    public ResponseEntity<String> operations(HttpServletRequest request) {
        Connection db = null;
        try {
            db = openReporting();
            AuditRunService.params(queryParams(request));
            return v1(200, runs.operations(db));
        } catch (AuditException e) {
            return v1Error(e);
        } catch (SQLException e) {
            return v1Error(AuditException.fail(500, "report_unavailable"));
        } finally {
            closeQuietly(db);
        }
    }

    // -- interventions ------------------------------------------------------

    @GetMapping("/interventions")
    public ResponseEntity<String> interventions(HttpServletRequest request) {
        if (!"GET".equalsIgnoreCase(request.getMethod())) {
            return interventionError(AuditException.fail(405, "method_not_allowed"));
        }
        try (Connection db = store.openStore()) {
            ObjectNode body = Json.MAPPER.createObjectNode();
            body.set("items", runs.interventions(db));
            return interventionOk(200, body);
        } catch (AuditException e) {
            return interventionError(e);
        } catch (SQLException e) {
            return interventionError(AuditException.fail(400, "invalid_intervention_request"));
        }
    }

    @GetMapping("/runs/audit-run-{id:[1-9][0-9]*}/intervention")
    public ResponseEntity<String> intervention(@PathVariable("id") long id) {
        try (Connection db = store.openStore()) {
            ObjectNode job = runs.jobRow(db, id);
            if (job == null) {
                throw AuditException.fail(404, "unknown_run");
            }
            ObjectNode t = runs.interventionFor(db, id, Json.text(job, "hospital"));
            if (t == null) {
                throw AuditException.fail(404, "no_intervention");
            }
            return interventionOk(200, t);
        } catch (AuditException e) {
            return interventionError(e);
        } catch (SQLException e) {
            return interventionError(AuditException.fail(400, "invalid_intervention_request"));
        }
    }

    @PostMapping("/runs/audit-run-{id:[1-9][0-9]*}/intervention/documents")
    public ResponseEntity<String> interventionDocuments(@PathVariable("id") long id,
                                                        HttpServletRequest request) throws IOException {
        try {
            if (!"1".equals(request.getHeader("x-review-request"))) {
                throw AuditException.fail(403, "forbidden");
            }
            byte[] raw = request.getInputStream().readAllBytes();
            if (raw.length > MAX_DOCUMENT_BODY) {
                throw AuditException.fail(413, "body_too_large");
            }
            JsonNode parsed;
            try {
                parsed = Json.MAPPER.readTree(raw);
            } catch (Exception e) {
                throw AuditException.fail(400, "invalid_intervention_request");
            }
            if (!parsed.isObject()) {
                throw AuditException.fail(400, "invalid_intervention_request");
            }
            ObjectNode body = (ObjectNode) parsed;
            try (Connection db = store.openStore()) {
                ObjectNode job = runs.jobRow(db, id);
                if (job == null) {
                    throw AuditException.fail(404, "unknown_run");
                }
                ObjectNode t = runs.interventionFor(db, id, Json.text(job, "hospital"));
                if (t == null) {
                    throw AuditException.fail(404, "no_intervention");
                }
                if (!"needs_human".equals(Json.text(t, "status"))) {
                    throw AuditException.fail(409, "already_resumed");
                }
                if (!body.path("public_document").isBoolean()
                        || !body.path("public_document").asBoolean()
                        || hasUnknownDocumentKey(body)) {
                    throw AuditException.fail(400, "public_document_confirmation_required");
                }
                String sourceUrl = Json.text(body, "source_url");
                String language = Json.text(body, "language");
                String retrievedAt = Json.text(body, "retrieved_at");
                ObjectNode diag = com.truth2power.service.AuditDiagnostics.failureDiagnostic(
                        "http_error", body);
                String publicUrl = diag == null ? null : Json.text(diag, "source_url");
                boolean retrievedOk = retrievedAt != null && RETRIEVED_AT.matcher(retrievedAt).matches()
                        && parseRetrievedAt(retrievedAt) != null
                        && !parseRetrievedAt(retrievedAt).isAfter(OffsetDateTime.now());
                if (publicUrl == null || !publicUrl.equals(sourceUrl)
                        || !List.of("en", "es", "und").contains(language) || !retrievedOk) {
                    throw AuditException.fail(400, "invalid_document_metadata");
                }
                String bytesB64 = Json.text(body, "bytes");
                if (bytesB64 == null || !BASE64.matcher(bytesB64).matches()) {
                    throw AuditException.fail(400, "invalid_pdf");
                }
                byte[] bytes;
                try {
                    bytes = Base64.getDecoder().decode(bytesB64);
                } catch (IllegalArgumentException e) {
                    throw AuditException.fail(400, "invalid_pdf");
                }
                if (bytes.length < 8 || bytes.length > 4 * 1024 * 1024
                        || !Base64.getEncoder().encodeToString(bytes).equals(bytesB64)
                        || bytes[0] != '%' || bytes[1] != 'P' || bytes[2] != 'D'
                        || bytes[3] != 'F' || bytes[4] != '-') {
                    throw AuditException.fail(400, "invalid_pdf");
                }
                if (!validPdf(bytes)) {
                    throw AuditException.fail(400, "invalid_or_unreadable_pdf");
                }
                String digest = Json.sha256Hex(bytes);
                for (JsonNode d : t.path("documents")) {
                    if (sourceUrl.equals(Json.text(d, "source_url"))) {
                        if (!digest.equals(Json.text(d, "sha256"))
                                || !retrievedAt.equals(Json.text(d, "retrieved_at"))
                                || !language.equals(Json.text(d, "language"))) {
                            throw AuditException.fail(409, "source_already_imported");
                        }
                        return interventionOk(200, (ObjectNode) d);
                    }
                }
                if (t.path("documents").size() >= 20) {
                    throw AuditException.fail(400, "document_limit");
                }
                ObjectNode doc = Json.MAPPER.createObjectNode();
                doc.put("source_url", sourceUrl);
                doc.put("sha256", digest);
                doc.put("artifact_path", "snapshots/" + digest + ".pdf");
                doc.put("retrieved_at", retrievedAt);
                doc.put("imported_at", AuditStore.now());
                doc.put("language", language);
                doc.put("capture_method", "human_import");
                doc.put("retrieval_attestation", "local_operator");
                doc.put("public_document", true);
                store.immutable(doc.path("artifact_path").asText(), bytes);
                AuditStore.event(db, id, null, "human_document_imported", doc);
                return interventionOk(201, doc);
            }
        } catch (AuditException e) {
            return interventionError(e);
        } catch (SQLException | IOException e) {
            return interventionError(AuditException.fail(400, "invalid_intervention_request"));
        }
    }

    private static boolean hasUnknownDocumentKey(ObjectNode body) {
        java.util.Set<String> allowed = java.util.Set.of("public_document", "source_url",
                "retrieved_at", "language", "bytes");
        for (java.util.Iterator<String> it = body.fieldNames(); it.hasNext();) {
            if (!allowed.contains(it.next())) {
                return true;
            }
        }
        return false;
    }

    private static OffsetDateTime parseRetrievedAt(String value) {
        try {
            return OffsetDateTime.parse(value);
        } catch (Exception e) {
            return null;
        }
    }

    /** The pypdf validation from interventions.js (15 s timeout). */
    private static boolean validPdf(byte[] bytes) {
        String python = System.getenv("T2P_PYTHON");
        if (python == null || python.isBlank()) {
            python = "python3";
        }
        String script = "import sys,io;from pypdf import PdfReader;r=PdfReader(io.BytesIO(sys.stdin.buffer.read()));"
                + "assert not r.is_encrypted;assert 0<len(r.pages)<=200";
        try {
            Process p = new ProcessBuilder(python, "-c", script)
                    .redirectErrorStream(true).start();
            p.getOutputStream().write(bytes);
            p.getOutputStream().close();
            boolean finished = p.waitFor(15, java.util.concurrent.TimeUnit.SECONDS);
            if (!finished) {
                p.destroyForcibly();
                return false;
            }
            return p.exitValue() == 0;
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return false;
        }
    }

    @PostMapping("/runs/audit-run-{id:[1-9][0-9]*}/intervention/resume")
    public ResponseEntity<String> interventionResume(@PathVariable("id") long id,
                                                     HttpServletRequest request) throws IOException {
        try {
            if (!"1".equals(request.getHeader("x-review-request"))) {
                throw AuditException.fail(403, "forbidden");
            }
            byte[] raw = request.getInputStream().readAllBytes();
            if (raw.length > MAX_BODY) {
                throw AuditException.fail(413, "body_too_large");
            }
            JsonNode parsed;
            try {
                parsed = Json.MAPPER.readTree(raw);
            } catch (Exception e) {
                throw AuditException.fail(400, "invalid_intervention_request");
            }
            if (!parsed.isObject()) {
                throw AuditException.fail(400, "invalid_intervention_request");
            }
            ObjectNode body = (ObjectNode) parsed;
            boolean confirmOnly = body.size() == 1 && body.path("confirm").isBoolean()
                    && body.path("confirm").asBoolean();
            if (!confirmOnly) {
                throw AuditException.fail(400, "confirmation_required");
            }
            try (Connection db = store.openStore()) {
                ObjectNode job = runs.jobRow(db, id);
                if (job == null) {
                    throw AuditException.fail(404, "unknown_run");
                }
                ObjectNode t = runs.interventionFor(db, id, Json.text(job, "hospital"));
                if (t == null) {
                    throw AuditException.fail(404, "no_intervention");
                }
                if ("resumed".equals(Json.text(t, "status"))) {
                    ObjectNode out = Json.MAPPER.createObjectNode();
                    out.put("audit_run_id", Json.text(t, "resumed_run_id"));
                    return interventionOk(200, out);
                }
                if (t.path("documents").isEmpty()) {
                    throw AuditException.fail(400, "documents_required");
                }
                ObjectNode manifest = Json.MAPPER.createObjectNode();
                manifest.put("schema_version", "human-import-v1");
                manifest.put("hospital_key", Json.text(job, "hospital"));
                manifest.put("parent_run_id", id);
                manifest.set("documents", t.path("documents"));
                byte[] manifestBytes = Json.stringify(manifest).getBytes(StandardCharsets.UTF_8);
                String digest = Json.sha256Hex(manifestBytes);
                store.immutable("human-imports/" + digest + ".json", manifestBytes);
                ObjectNode childBody = Json.MAPPER.createObjectNode();
                childBody.put("year", job.path("year").asInt());
                childBody.put("review_date", Json.text(job, "review_date"));
                childBody.put("mode", "replay");
                childBody.put("manual_import", digest);
                childBody.put("request_key", "human-resume-" + id + "-" + digest);
                long child;
                try {
                    child = enqueue.enqueuePipeline(db, childBody, Json.text(job, "hospital"));
                } catch (IllegalArgumentException e) {
                    throw AuditException.fail(400, "invalid_intervention_request");
                }
                ObjectNode resumedDetail = Json.MAPPER.createObjectNode();
                resumedDetail.put("audit_run_id", AuditRunService.runId(child));
                resumedDetail.put("manifest_sha256", digest);
                AuditStore.event(db, id, null, "human_resumed", resumedDetail);
                ObjectNode linkedDetail = Json.MAPPER.createObjectNode();
                linkedDetail.put("parent_run_id", AuditRunService.runId(id));
                linkedDetail.put("manifest_sha256", digest);
                AuditStore.event(db, child, null, "human_import_linked", linkedDetail);
                ObjectNode out = Json.MAPPER.createObjectNode();
                out.put("audit_run_id", AuditRunService.runId(child));
                return interventionOk(202, out);
            }
        } catch (AuditException e) {
            return interventionError(e);
        } catch (SQLException e) {
            return interventionError(AuditException.fail(400, "invalid_intervention_request"));
        }
    }

    // -- catch-all ----------------------------------------------------------

    /**
     * Any other v1 path, or a wrong method on a matched path: non-GET is 405,
     * GET is 404 {@code unknown_endpoint} — the order in reportingRoute.
     */
    @RequestMapping("/**")
    public ResponseEntity<String> catchAll(HttpServletRequest request) {
        if (!"GET".equalsIgnoreCase(request.getMethod())) {
            return v1Error(AuditException.fail(405, "method_not_allowed"));
        }
        return v1Error(AuditException.fail(404, "unknown_endpoint"));
    }
}
