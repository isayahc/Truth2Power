package com.truth2power.controller;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.truth2power.service.AuditException;
import com.truth2power.service.GradingService;
import com.truth2power.service.Json;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The grading read views — port of backend/grading/routes.js.
 *
 * <p>Envelope is plain {@code {"error": "<sentence>"}}. Non-GET is 405
 * {@code "Use GET."}; an unmatched path is 404 {@code "Unknown
 * assessment."}. The report itself comes from the Node grader (via
 * GradingService), never from a Java port of the grading logic.
 */
@RestController
@RequestMapping("/api/grading")
public class GradingController {

    private final GradingService grading;

    public GradingController(GradingService grading) {
        this.grading = grading;
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

    @GetMapping("/hospitals/{key:\\d{1,8}|t2p-\\d+}")
    public ResponseEntity<String> hospital(@PathVariable("key") String key) {
        try {
            return json(200, grading.gradeHospital(key));
        } catch (AuditException e) {
            return error(e.status, e.code);
        }
    }

    @GetMapping("/demo")
    public ResponseEntity<String> demo() {
        try {
            return json(200, grading.gradeDemo());
        } catch (AuditException e) {
            return error(e.status, e.code);
        }
    }

    @RequestMapping("/**")
    public ResponseEntity<String> catchAll(HttpServletRequest request) {
        if (!"GET".equalsIgnoreCase(request.getMethod())) {
            return error(405, "Use GET.");
        }
        return error(404, "Unknown assessment.");
    }
}
