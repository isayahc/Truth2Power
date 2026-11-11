package com.truth2power.controller;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.truth2power.service.DbReadService;
import com.truth2power.service.Json;
import com.truth2power.service.OverviewService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Port of the /api/overview branch of backend/src/handler.js. */
@RestController
public class OverviewController {

    private final OverviewService overview;
    private final DbReadService dbReads;

    @Value("${t2p.reads-from-db:false}")
    private boolean readsFromDb;

    public OverviewController(OverviewService overview, DbReadService dbReads) {
        this.overview = overview;
        this.dbReads = dbReads;
    }

    @RequestMapping("/api/overview")
    public void overview(HttpServletRequest request, HttpServletResponse response) throws Exception {
        if (!"GET".equals(request.getMethod())) {
            DatasetController.errorJson(response, 405, "Use GET.", null);
            return;
        }
        try {
            ObjectNode data;
            if (readsFromDb && dbReads.dbAvailable()) {
                data = overview.overviewFromDb(dbReads.rosterFeatures(), dbReads.regionByCounty());
            } else {
                data = overview.overview();
            }
            DatasetController.writePlainJson(response, 200, Json.stringify(data), true);
        } catch (Exception e) {
            // Log server-side like the old handler does (console.error on
            // review_request_failed); the client only gets the generic 500.
            org.slf4j.LoggerFactory.getLogger(OverviewController.class)
                    .error("Audit overview could not be loaded.", e);
            DatasetController.errorJson(response, 500, "Audit overview could not be loaded.", null);
        }
    }
}
