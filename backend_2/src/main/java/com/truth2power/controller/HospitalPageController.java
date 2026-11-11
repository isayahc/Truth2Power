package com.truth2power.controller;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.truth2power.service.HospitalPageService;
import com.truth2power.service.Json;
import com.truth2power.service.ReportingContextService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Port of the hospital-page and reporting-context branches of
 * backend/src/handler.js — same routes, same status codes, same messages,
 * including the optimistic ?revision= check (409 on mismatch).
 */
@RestController
public class HospitalPageController {

    private final HospitalPageService pages;
    private final ReportingContextService reporting;

    public HospitalPageController(HospitalPageService pages, ReportingContextService reporting) {
        this.pages = pages;
        this.reporting = reporting;
    }

    @RequestMapping("/api/hospitals/{id:\\d{1,8}|t2p-\\d+}/page")
    public void page(HttpServletRequest request, HttpServletResponse response,
            @PathVariable("id") String id,
            @RequestParam(value = "revision", required = false) String revision) throws Exception {
        if (!"GET".equals(request.getMethod())) {
            DatasetController.errorJson(response, 405, "Use GET.", null);
            return;
        }
        try {
            ObjectNode data = pages.hospitalPage(id);
            String expected = revision;
            if (expected != null && !expected.equals(data == null ? "unassessed" : Json.text(data, "revision"))) {
                DatasetController.errorJson(response, 409, "Assessment changed since the overview was loaded.", null);
                return;
            }
            if (data == null) {
                DatasetController.errorJson(response, 404, "Hospital page not yet assessed.", null);
                return;
            }
            DatasetController.writePlainJson(response, 200, Json.stringify(data), true);
        } catch (Exception e) {
            DatasetController.errorJson(response, 500, "Hospital page could not be loaded.", null);
        }
    }

    @RequestMapping("/api/hospitals/{id:\\d{1,8}|t2p-\\d+}/reporting-context")
    public void reportingContext(HttpServletRequest request, HttpServletResponse response,
            @PathVariable("id") String id) throws Exception {
        String method = request.getMethod();
        if (!"GET".equals(method) && !"HEAD".equals(method)) {
            response.setStatus(405);
            response.addHeader("Content-Type", "application/json; charset=utf-8");
            response.setHeader("Allow", "GET, HEAD");
            ObjectNode body = Json.MAPPER.createObjectNode();
            body.put("error", "Use GET or HEAD.");
            response.getOutputStream().write(Json.stringify(body).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return;
        }
        try {
            ObjectNode context = reporting.reportingContext(id);
            if (context == null) {
                DatasetController.errorJson(response, 404, "Reporting context has not been assessed for this hospital.", null);
                return;
            }
            response.setStatus(200);
            response.addHeader("Content-Type", "application/json; charset=utf-8");
            if ("GET".equals(method)) {
                response.getOutputStream().write(Json.stringify(context).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            DatasetController.errorJson(response, 500, "Reporting context could not be loaded.", null);
        }
    }
}
