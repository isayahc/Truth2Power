package com.truth2power.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.truth2power.service.Json;
import com.truth2power.service.ReviewService;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Port of reviewHandler in backend/src/handler.js. Routes:
 * GET /api/reviews, GET /api/reviews/{id}, GET /api/reviews/{id}/sources/{snapshot},
 * POST /api/reviews/{id}/decisions. Anything else under /api/reviews/* is 404
 * {"error":"Review endpoint not found."}. Successful JSON: 200, no-store.
 * The POST guard has two layers like the old app: ReviewPostGuardFilter
 * (Layer A: loopback host, x-review-request header, Origin, 8 KB cap — bare
 * 403) and the header re-check here (Layer B: 403 {"error":"Review request
 * rejected."}).
 */
@RestController
@RequestMapping("/api/reviews")
public class ReviewController {

    private final ReviewService reviews;

    public ReviewController(ReviewService reviews) {
        this.reviews = reviews;
    }

    private static ResponseEntity<String> error(int status, String message) {
        ObjectNode body = Json.MAPPER.createObjectNode();
        body.put("error", message);
        return ResponseEntity.status(status)
                .contentType(MediaType.parseMediaType("application/json; charset=utf-8"))
                .body(Json.stringify(body));
    }

    private static ResponseEntity<String> ok(ObjectNode body) {
        return ResponseEntity.ok()
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .contentType(MediaType.APPLICATION_JSON)
                .body(Json.stringify(body));
    }

    @GetMapping
    public ResponseEntity<String> list(@RequestParam Map<String, String> query) {
        try {
            Map<String, String> filters = new HashMap<>();
            for (String key : new String[]{"hospital_key", "namespace", "source_id", "role", "language"}) {
                if (query.get(key) != null) {
                    filters.put(key, query.get(key));
                }
            }
            return ok(reviews.list(filters));
        } catch (ReviewService.ReviewException e) {
            return error(e.getStatus(), e.getMessage());
        } catch (Exception e) {
            return error(500, "The review request could not be completed.");
        }
    }

    @GetMapping("/{id}")
    public ResponseEntity<String> detail(@PathVariable String id) {
        try {
            return ok(reviews.detail(id));
        } catch (ReviewService.ReviewException e) {
            return error(e.getStatus(), e.getMessage());
        } catch (Exception e) {
            return error(500, "The review request could not be completed.");
        }
    }

    @GetMapping("/{id}/sources/{snapshotId}")
    public ResponseEntity<byte[]> source(@PathVariable String id, @PathVariable String snapshotId) {
        try {
            ReviewService.SourceResult result = reviews.source(id, snapshotId);
            ResponseEntity.BodyBuilder builder = ResponseEntity.ok()
                    .header("Content-Security-Policy", "sandbox")
                    .header("X-Content-Type-Options", "nosniff")
                    .contentType(MediaType.parseMediaType(result.contentType()));
            if (result.contentDisposition() != null) {
                builder.header(HttpHeaders.CONTENT_DISPOSITION, result.contentDisposition());
            }
            return builder.body(result.body());
        } catch (ReviewService.ReviewException e) {
            ObjectNode body = Json.MAPPER.createObjectNode();
            body.put("error", e.getMessage());
            return ResponseEntity.status(e.getStatus())
                    .contentType(MediaType.parseMediaType("application/json; charset=utf-8"))
                    .body(Json.stringify(body).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (Exception e) {
            ObjectNode body = Json.MAPPER.createObjectNode();
            body.put("error", "The review request could not be completed.");
            return ResponseEntity.status(500)
                    .contentType(MediaType.parseMediaType("application/json; charset=utf-8"))
                    .body(Json.stringify(body).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
    }

    @PostMapping("/{id}/decisions")
    public ResponseEntity<String> decide(@PathVariable String id, HttpServletRequest request,
                                         @RequestBody(required = false) String body) {
        // Layer B: the handler re-checks the header even though the filter (Layer A)
        // already enforced it — same as backend/src/handler.js:25.
        if (!"1".equals(request.getHeader("x-review-request"))) {
            return error(403, "Review request rejected.");
        }
        if (body == null || body.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 8192) {
            return error(400, "Invalid review decision.");
        }
        ObjectNode input;
        try {
            JsonNode parsed = Json.MAPPER.readTree(body);
            if (!parsed.isObject()) {
                return error(400, "Invalid review decision.");
            }
            input = (ObjectNode) parsed;
        } catch (IOException e) {
            return error(400, "Invalid review decision.");
        }
        try {
            return ok(reviews.decide(id, input));
        } catch (ReviewService.ReviewException e) {
            return error(e.getStatus(), e.getMessage());
        } catch (Exception e) {
            return error(500, "The review request could not be completed.");
        }
    }

    /** Any other /api/reviews/* path or method: 404, like handler.js. */
    @RequestMapping("/**")
    public ResponseEntity<String> notFound() {
        return error(404, "Review endpoint not found.");
    }
}
