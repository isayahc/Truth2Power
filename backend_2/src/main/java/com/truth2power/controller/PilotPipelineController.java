package com.truth2power.controller;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.truth2power.service.AuditEnqueueService;
import com.truth2power.service.AuditRunService;
import com.truth2power.service.AuditStore;
import com.truth2power.service.Json;
import com.truth2power.service.PipelineViews;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.List;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The non-v1 pipeline routes — port of backend/audit/pipeline-routes.js.
 *
 * <p>Error envelope is plain {@code {"error": "<sentence>"}} (no
 * schema_version, no machine code). Success JSON carries
 * {@code Cache-Control: no-store}. The queue POST is the same
 * enqueuePipeline the v1 route uses; every enqueue throw collapses to 400
 * {@code "Invalid or conflicting audit request."} here.
 */
@RestController
@RequestMapping("/api/pilot")
public class PilotPipelineController {

    private static final java.util.Set<String> ALLOWED_KEYS = java.util.Set.of(
            "year", "review_date", "mode", "variant", "request_key", "discovery_bounds");

    private final AuditStore store;
    private final AuditRunService runs;
    private final AuditEnqueueService enqueue;

    public PilotPipelineController(AuditStore store, AuditRunService runs, AuditEnqueueService enqueue) {
        this.store = store;
        this.runs = runs;
        this.enqueue = enqueue;
    }

    private static ResponseEntity<String> json(int status, ObjectNode body) {
        return ResponseEntity.status(status)
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .contentType(MediaType.APPLICATION_JSON)
                .body(Json.stringify(body));
    }

    private static ResponseEntity<String> error(int status, String message) {
        ObjectNode body = Json.MAPPER.createObjectNode();
        body.put("error", message);
        return json(status, body);
    }

    @PostMapping("/hospitals/{key:\\d{1,8}|t2p-\\d{1,8}}")
    public ResponseEntity<String> queuePipeline(@PathVariable("key") String key,
                                                HttpServletRequest request) throws IOException {
        if (!"1".equals(request.getHeader("x-review-request"))) {
            return error(403, "Local request header required.");
        }
        byte[] raw = request.getInputStream().readAllBytes();
        ObjectNode options;
        try {
            com.fasterxml.jackson.databind.JsonNode parsed = raw.length == 0
                    ? Json.MAPPER.createObjectNode() : Json.MAPPER.readTree(raw);
            if (!parsed.isObject()) {
                return error(400, "Invalid or conflicting audit request.");
            }
            options = (ObjectNode) parsed;
        } catch (Exception e) {
            return error(400, "Invalid or conflicting audit request.");
        }
        if ("synthetic".equals(Json.text(options, "mode"))
                && !"1".equals(System.getenv("T2P_PILOT_DEMO"))) {
            return error(403, "Synthetic runs require the isolated demo mode.");
        }
        for (java.util.Iterator<String> it = options.fieldNames(); it.hasNext();) {
            if (!ALLOWED_KEYS.contains(it.next())) {
                return error(400, "Unsupported audit option.");
            }
        }
        try (Connection db = store.openStore()) {
            long id = enqueue.enqueuePipeline(db, options, key);
            ObjectNode body = Json.MAPPER.createObjectNode();
            body.put("id", id);
            body.put("audit_run_id", AuditRunService.runId(id));
            return json(202, body);
        } catch (Exception e) {
            return error(400, "Invalid or conflicting audit request.");
        }
    }

    @GetMapping("/hospitals/{key:\\d{1,8}|t2p-\\d{1,8}}")
    public ResponseEntity<String> hospital(@PathVariable("key") String key) {
        try {
            ObjectNode data = runs.publications();
            ObjectNode job = null;
            ObjectNode scan = null;
            for (ObjectNode j : jobs(data)) {
                if (key.equals(Json.text(j, "hospital"))) {
                    if (job == null) {
                        job = j;
                    }
                    if (scan == null && "discovery_only".equals(Json.text(j.path("context"), "mode"))
                            && "completed".equals(Json.text(j, "status"))) {
                        scan = j;
                    }
                }
            }
            ObjectNode out = Json.MAPPER.createObjectNode();
            if (job == null) {
                out.putNull("job");
            } else {
                ObjectNode publicJob = Json.MAPPER.createObjectNode();
                for (String k : List.of("id", "status", "attempted", "attempts", "error", "year")) {
                    publicJob.set(k, job.path(k));
                }
                publicJob.put("mode", Json.text(job.path("context"), "mode"));
                out.set("job", publicJob);
            }
            out.put("demo_enabled", "1".equals(System.getenv("T2P_PILOT_DEMO")));
            if (scan == null) {
                out.putNull("latest_scan");
            } else {
                try {
                    out.put("latest_scan",
                            Json.MAPPER.readTree(scan.path("checkpoint").asText())
                                    .path("scan_id").asText(null));
                } catch (Exception e) {
                    out.putNull("latest_scan");
                }
            }
            String latest = null;
            for (ObjectNode b : bundles(data)) {
                if (key.equals(Json.text(b.path("input"), "hospital_key"))) {
                    latest = Json.text(b, "id");
                    break;
                }
            }
            if (latest == null) {
                out.putNull("latest");
            } else {
                out.put("latest", latest);
            }
            return json(200, out);
        } catch (Exception e) {
            return ResponseEntity.status(500).build();
        }
    }

    @GetMapping("/scans/{id:[a-f0-9]{64}}")
    public ResponseEntity<String> scan(@PathVariable("id") String id) {
        try {
            ObjectNode data = runs.publications();
            ObjectNode found = null;
            for (ObjectNode j : jobs(data)) {
                if (!"discovery_only".equals(Json.text(j.path("context"), "mode"))
                        || !"completed".equals(Json.text(j, "status"))) {
                    continue;
                }
                String scanId = null;
                try {
                    scanId = Json.MAPPER.readTree(j.path("checkpoint").asText())
                            .path("scan_id").asText(null);
                } catch (Exception ignored) {
                    // no checkpoint
                }
                if (id.equals(scanId)) {
                    found = j;
                    break;
                }
            }
            if (found == null) {
                return error(404, "Scan not found.");
            }
            try {
                ObjectNode doc = (ObjectNode) Json.MAPPER.readTree(
                        store.readArtifact("pipeline-scans/" + id + ".json"));
                String savedId = Json.text(doc, "id");
                doc.remove("id");
                long jobId = found.path("id").asLong();
                if (!id.equals(savedId) || !Json.fingerprint(doc).equals(id)
                        || doc.path("job").asLong(-1) != jobId) {
                    throw new IllegalStateException("Scan integrity check failed.");
                }
                ObjectNode out = Json.MAPPER.createObjectNode();
                out.put("id", id);
                out.setAll(doc);
                return json(200, out);
            } catch (Exception e) {
                return error(422, "Scan integrity check failed.");
            }
        } catch (Exception e) {
            return ResponseEntity.status(500).build();
        }
    }

    @GetMapping("/assessments/{id:[a-f0-9]{64}}")
    public ResponseEntity<String> assessment(@PathVariable("id") String id) {
        try {
            ObjectNode data = runs.publications();
            for (ObjectNode b : bundles(data)) {
                if (id.equals(Json.text(b, "id"))) {
                    return json(200, b);
                }
            }
            return error(404, "Assessment not found.");
        } catch (Exception e) {
            return ResponseEntity.status(500).build();
        }
    }

    @GetMapping("/snapshots/{id:[a-f0-9]{64}}")
    public ResponseEntity<byte[]> snapshot(@PathVariable("id") String id) {
        try {
            ObjectNode data = runs.publications();
            ObjectNode found = null;
            for (ObjectNode b : bundles(data)) {
                for (com.fasterxml.jackson.databind.JsonNode s : b.path("input").path("sources")) {
                    com.fasterxml.jackson.databind.JsonNode snap = s.path("snapshot");
                    if (!snap.isMissingNode() && !snap.isNull()
                            && id.equals(Json.text(snap, "sha256"))) {
                        found = (ObjectNode) snap;
                        break;
                    }
                }
                if (found != null) {
                    break;
                }
            }
            if (found == null) {
                return snapshotError(404, "Snapshot not referenced by a committed assessment.");
            }
            byte[] bytes;
            try {
                bytes = store.readArtifact(Json.text(found, "artifact_path"));
            } catch (IOException e) {
                return snapshotError(404, "Snapshot unavailable.");
            }
            if (!Json.sha256Hex(bytes).equals(id)) {
                return snapshotError(422, "Snapshot integrity check failed.");
            }
            String filename = Json.text(found, "artifact_path");
            filename = filename.substring(filename.lastIndexOf('/') + 1);
            return ResponseEntity.status(200)
                    .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + filename + "\"")
                    .header("Content-Security-Policy", "sandbox")
                    .header("X-Content-Type-Options", "nosniff")
                    .contentType(MediaType.APPLICATION_OCTET_STREAM)
                    .body(bytes);
        } catch (Exception e) {
            return ResponseEntity.status(500).build();
        }
    }

    private ResponseEntity<byte[]> snapshotError(int status, String message) {
        ObjectNode body = Json.MAPPER.createObjectNode();
        body.put("error", message);
        return ResponseEntity.status(status)
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .contentType(MediaType.APPLICATION_JSON)
                .body(Json.stringify(body).getBytes(StandardCharsets.UTF_8));
    }

    @RequestMapping("/**")
    public ResponseEntity<String> catchAll(HttpServletRequest request) {
        if (!"GET".equalsIgnoreCase(request.getMethod())) {
            return error(405, "Use GET or a supported queue request.");
        }
        return error(404, "Unknown pipeline endpoint.");
    }

    // -- publications helpers (pipeline-store.js publications()) ----------

    private static List<ObjectNode> jobs(ObjectNode data) {
        List<ObjectNode> out = new java.util.ArrayList<>();
        for (com.fasterxml.jackson.databind.JsonNode j : data.path("jobs")) {
            out.add((ObjectNode) j);
        }
        return out;
    }

    private static List<ObjectNode> bundles(ObjectNode data) {
        List<ObjectNode> out = new java.util.ArrayList<>();
        for (com.fasterxml.jackson.databind.JsonNode b : data.path("bundles")) {
            out.add((ObjectNode) b);
        }
        return out;
    }
}
