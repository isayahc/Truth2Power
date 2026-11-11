package com.truth2power.controller;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.truth2power.service.ChangesService;
import com.truth2power.service.Json;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Base64;
import java.util.regex.Pattern;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Port of backend/changes/routes.js. GET /api/changes replays the saved
 * captures (60 s timeout); GET /api/changes/assessments/{sha256} serves one
 * of two pre-loaded posting assessments; GET /api/changes/snapshots/{sha}.{ext}
 * serves a hash-verified snapshot as base64. Any non-GET under /api/changes/*
 * is 405 {"error":"Use GET."}; unknown GET paths are 404
 * {"error":"Unknown change endpoint."}.
 */
@RestController
@RequestMapping("/api/changes")
public class ChangesController {

    private static final Pattern ASSESSMENT = Pattern.compile("^[a-f0-9]{64}$");
    private static final Pattern SNAPSHOT = Pattern.compile("^([a-f0-9]{64})\\.(html|pdf|docx)$");

    private final ChangesService changes;

    public ChangesController(ChangesService changes) {
        this.changes = changes;
    }

    private static ResponseEntity<String> error(int status, String message) {
        ObjectNode body = Json.MAPPER.createObjectNode();
        body.put("error", message);
        return ResponseEntity.status(status)
                .contentType(MediaType.parseMediaType("application/json; charset=utf-8"))
                .body(Json.stringify(body));
    }

    @GetMapping
    public ResponseEntity<String> feed() {
        try {
            ObjectNode data = changes.feed();
            return ResponseEntity.ok()
                    .header(HttpHeaders.CACHE_CONTROL, "no-store")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(Json.stringify(data));
        } catch (Exception e) {
            return error(503, "Could not replay the saved captures.");
        }
    }

    @GetMapping("/assessments/{sha256}")
    public ResponseEntity<byte[]> assessment(@PathVariable String sha256) {
        if (!ASSESSMENT.matcher(sha256).matches()) {
            return unknown();
        }
        byte[] bytes = changes.assessment(sha256);
        if (bytes == null) {
            return unknown();
        }
        return ResponseEntity.ok()
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .contentType(MediaType.APPLICATION_JSON)
                .body(bytes);
    }

    @GetMapping("/snapshots/{filename}")
    public ResponseEntity<String> snapshot(@PathVariable String filename) {
        var match = SNAPSHOT.matcher(filename);
        if (!match.matches()) {
            return error(404, "Unknown change endpoint.");
        }
        try {
            ChangesService.SnapshotResult result = changes.snapshot(match.group(1), match.group(2));
            String base64 = Base64.getEncoder().encodeToString(result.raw());
            return ResponseEntity.ok()
                    .header("X-Content-Type-Options", "nosniff")
                    .header("Content-Security-Policy", "sandbox")
                    .header(HttpHeaders.CONTENT_DISPOSITION,
                            "attachment; filename=\"" + result.filename() + "\"")
                    .contentType(MediaType.APPLICATION_OCTET_STREAM)
                    .body(base64);
        } catch (ChangesService.ChangesException e) {
            return error(e.getStatus(), e.getMessage());
        } catch (Exception e) {
            return error(404, "Original snapshot unavailable.");
        }
    }

    /** Non-GET under /api/changes/* is 405; unknown GET paths are 404. */
    @RequestMapping("/**")
    public ResponseEntity<String> fallback(HttpServletRequest request) {
        if (!"GET".equalsIgnoreCase(request.getMethod())) {
            return error(405, "Use GET.");
        }
        return error(404, "Unknown change endpoint.");
    }

    private ResponseEntity<byte[]> unknown() {
        ObjectNode body = Json.MAPPER.createObjectNode();
        body.put("error", "Unknown change endpoint.");
        return ResponseEntity.status(404)
                .contentType(MediaType.parseMediaType("application/json; charset=utf-8"))
                .body(Json.stringify(body).getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
}
