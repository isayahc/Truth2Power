package com.truth2power.controller;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.truth2power.service.Json;
import com.truth2power.service.OverviewService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Port of the /api/overview branch of backend/src/handler.js. */
@RestController
public class OverviewController {

    private final OverviewService overview;

    public OverviewController(OverviewService overview) {
        this.overview = overview;
    }

    @RequestMapping("/api/overview")
    public void overview(HttpServletRequest request, HttpServletResponse response) throws Exception {
        if (!"GET".equals(request.getMethod())) {
            DatasetController.errorJson(response, 405, "Use GET.", null);
            return;
        }
        try {
            ObjectNode data = overview.overview();
            DatasetController.writePlainJson(response, 200, Json.stringify(data), true);
        } catch (Exception e) {
            DatasetController.errorJson(response, 500, "Audit overview could not be loaded.", null);
        }
    }
}
