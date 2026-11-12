package com.truth2power.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.truth2power.config.RepoPaths;
import com.truth2power.service.AuditEnqueueService;
import com.truth2power.service.AuditStore;
import com.truth2power.service.Json;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The local-only demo surface — port of backend/audit/routes.js
 * ({@code auditRoute}), mounted in local-server.js ahead of the API handler.
 *
 * <p>Unlike the reporting routes, these have no schema_version envelope:
 * fixtures and snapshots are raw bytes with bare 404s, the 362 JSON is
 * plain, and the POST guard is its own inline check with the
 * {@code x-audit-request} header (Layer A does not apply here).
 */
@RestController
public class AuditsController {

    private final RepoPaths paths;
    private final AuditStore store;
    private final AuditEnqueueService enqueue;

    public AuditsController(RepoPaths paths, AuditStore store, AuditEnqueueService enqueue) {
        this.paths = paths;
        this.store = store;
        this.enqueue = enqueue;
    }

    @GetMapping("/audit-demo/{name}")
    public ResponseEntity<byte[]> demoFixture(@PathVariable("name") String name) throws IOException {
        if (!"index.html".equals(name) && !"application.pdf".equals(name)) {
            return ResponseEntity.status(404).build();
        }
        Path file = paths.repoRoot().resolve("backend/audit/fixture/" + name);
        byte[] bytes = Files.readAllBytes(file);
        MediaType type = name.endsWith(".pdf") ? MediaType.APPLICATION_PDF : MediaType.TEXT_HTML;
        return ResponseEntity.status(200).contentType(type).body(bytes);
    }

    @GetMapping("/api/audits/snapshots/{sha:[a-f0-9]{64}}")
    public ResponseEntity<byte[]> snapshot(@PathVariable("sha") String sha) {
        try {
            byte[] bytes = Files.readAllBytes(store.auditDir().resolve("snapshots/" + sha + ".pdf"));
            return ResponseEntity.status(200).contentType(MediaType.APPLICATION_PDF).body(bytes);
        } catch (IOException e) {
            return ResponseEntity.status(404).build();
        }
    }

    @GetMapping("/api/audits/362")
    public ResponseEntity<String> hospital362() {
        try (Connection db = store.openStore()) {
            ObjectNode job = null;
            try (PreparedStatement ps = db.prepareStatement(
                    "SELECT id,status,attempted,attempts,error,review_date,year FROM jobs "
                            + "WHERE hospital='362' AND rule='application.fpl_guidelines' "
                            + "ORDER BY id DESC LIMIT 1")) {
                try (ResultSet rs = ps.executeQuery()) {
                    if (rs.next()) {
                        job = Json.MAPPER.createObjectNode();
                        job.put("id", rs.getLong("id"));
                        job.put("status", rs.getString("status"));
                        job.put("attempted", rs.getString("attempted"));
                        job.put("attempts", rs.getInt("attempts"));
                        job.put("error", rs.getString("error"));
                        job.put("review_date", rs.getString("review_date"));
                        job.put("year", rs.getInt("year"));
                    }
                }
            }
            JsonNode latest = enqueue.demoHistory(db, "362");
            ObjectNode out = Json.MAPPER.createObjectNode();
            if (job == null) {
                out.putNull("job");
            } else {
                out.set("job", job);
            }
            if (latest == null) {
                out.putNull("latest");
            } else {
                out.set("latest", latest);
            }
            return ResponseEntity.status(200)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(Json.stringify(out));
        } catch (SQLException e) {
            return ResponseEntity.status(500).build();
        }
    }

    @PostMapping("/api/audits/362/{year:2025|2026}")
    public ResponseEntity<String> enqueue362(@PathVariable("year") int year,
                                             HttpServletRequest request) {
        int port = request.getLocalPort();
        String host = request.getHeader("Host");
        String origin = request.getHeader("Origin");
        boolean hostOk = ("127.0.0.1:" + port).equals(host) || ("localhost:" + port).equals(host);
        boolean originOk = origin == null
                || ("http://127.0.0.1:" + port).equals(origin)
                || ("http://localhost:" + port).equals(origin);
        boolean headerOk = "1".equals(request.getHeader("x-audit-request"));
        if (!hostOk || !originOk || !headerOk) {
            return ResponseEntity.status(403)
                    .header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                    .body("{}");
        }
        try (Connection db = store.openStore()) {
            long id = enqueue.enqueueDemo(db, year);
            ObjectNode out = Json.MAPPER.createObjectNode();
            out.put("id", id);
            return ResponseEntity.status(202)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(Json.stringify(out));
        } catch (SQLException e) {
            return ResponseEntity.status(500).build();
        }
    }
}
