package com.truth2power.controller;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.truth2power.config.RepoPaths;
import com.truth2power.service.Json;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * Port of the dataset branch of backend/src/handler.js — serves the public
 * atlas datasets byte-for-byte: hospitals.geojson, counties.geojson and
 * hospital-coordinates.csv, with the same content types and method rules.
 *
 * Headers are written through the servlet response so the Content-Type
 * keeps the old server's exact spelling ({@code "; charset=utf-8"} with a
 * space) — Spring's MediaType rendering would strip it.
 */
@RestController
public class DatasetController {

    private final RepoPaths paths;

    public DatasetController(RepoPaths paths) {
        this.paths = paths;
    }

    private void serve(HttpServletRequest request, HttpServletResponse response,
            String filename, String type) throws Exception {
        String method = request.getMethod();
        if (!"GET".equals(method) && !"HEAD".equals(method)) {
            errorJson(response, 405, "Use GET or HEAD.", "GET, HEAD");
            return;
        }
        try {
            byte[] body = Files.readAllBytes(paths.mapsDir().resolve(filename));
            response.setStatus(200);
            response.addHeader("Content-Type", type + "; charset=utf-8");
            if ("GET".equals(method)) response.getOutputStream().write(body);
        } catch (Exception e) {
            errorJson(response, 500, "The dataset could not be loaded.", null);
        }
    }

    @RequestMapping("/api/hospitals")
    public void hospitals(HttpServletRequest request, HttpServletResponse response) throws Exception {
        serve(request, response, "hospitals.geojson", "application/geo+json");
    }

    @RequestMapping("/api/counties")
    public void counties(HttpServletRequest request, HttpServletResponse response) throws Exception {
        serve(request, response, "counties.geojson", "application/geo+json");
    }

    @RequestMapping("/api/coordinates.csv")
    public void coordinates(HttpServletRequest request, HttpServletResponse response) throws Exception {
        serve(request, response, "hospital-coordinates.csv", "text/csv");
    }

    /** Unknown /api paths answer the way the old handler does. */
    @RequestMapping("/api/**")
    public void unknown(HttpServletRequest request, HttpServletResponse response) throws Exception {
        errorJson(response, 404, "Dataset not found.", null);
    }

    static void errorJson(HttpServletResponse response, int status, String message, String allow) throws Exception {
        ObjectNode body = Json.MAPPER.createObjectNode();
        body.put("error", message);
        writeJson(response, status, Json.stringify(body), false, allow);
    }

    static void writeJson(HttpServletResponse response, int status, String body,
            boolean noStore, String allow) throws Exception {
        response.setStatus(status);
        response.addHeader("Content-Type", "application/json; charset=utf-8");
        if (noStore) response.setHeader("Cache-Control", "no-store");
        if (allow != null) response.setHeader("Allow", allow);
        response.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
    }

    /** Plain application/json (no charset) — the old page/overview success content type. */
    static void writePlainJson(HttpServletResponse response, int status, String body, boolean noStore) throws Exception {
        response.setStatus(status);
        response.setHeader("Content-Type", "application/json");
        if (noStore) response.setHeader("Cache-Control", "no-store");
        response.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
    }
}
