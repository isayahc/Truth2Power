package com.truth2power.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.net.InetAddress;
import java.net.URI;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Port of backend/audit/failure-diagnostic.js — safe, structured failure
 * metadata shared by persistence and public reporting. Only public metadata
 * reaches HTTP; credentials, query strings, fragments and local destinations
 * are stripped from source URLs.
 */
public final class AuditDiagnostics {

    private AuditDiagnostics() {
    }

    private static final Map<String, String> MESSAGES = Map.ofEntries(
            Map.entry("website_verification_required",
                    "Human intervention required: website verification."),
            Map.entry("off_host_document_blocked",
                    "The collector blocked a hospital-linked file because it was hosted on another domain."),
            Map.entry("source_host_blocked",
                    "Source URL is outside discovery scope or is not valid HTTPS."),
            Map.entry("unsafe_destination",
                    "Source resolves to a private or internal address. Retrieval blocked."),
            Map.entry("redirect_loop", "Source redirect loop detected."),
            Map.entry("redirect_limit", "Source exceeded the redirect limit."),
            Map.entry("tls_certificate_invalid",
                    "TLS certificate verification failed. Check the worker trust store and website certificate chain."),
            Map.entry("dns_resolution_failed",
                    "The worker could not resolve the website hostname. Check DNS from the worker."),
            Map.entry("retrieval_timeout",
                    "The website did not respond before the retrieval deadline."),
            Map.entry("invalid_document",
                    "The response did not contain a valid PDF or Word document."),
            Map.entry("invalid_content",
                    "The response did not contain the expected page."),
            Map.entry("resource_limit", "The collection reached a resource limit."),
            Map.entry("http_error", "The website returned an HTTP error."),
            Map.entry("collection_failed",
                    "Source collection failed. A specific cause was not recorded."));

    private static final Pattern HOSTNAME = Pattern.compile("^[a-z0-9.-]+\\.[a-z]+$", Pattern.CASE_INSENSITIVE);
    private static final Pattern LOCAL_SUFFIX = Pattern.compile("\\.(local|internal|localhost)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern IPV4 = Pattern.compile("^\\d{1,3}(\\.\\d{1,3}){3}$");
    private static final Pattern MANIFEST_ID = Pattern.compile("^[a-f0-9]{32}$");

    private static boolean isIp(String host) {
        if (host == null) {
            return false;
        }
        if (host.contains(":")) {
            return true; // IPv6 literal
        }
        if (!IPV4.matcher(host).matches()) {
            return false;
        }
        try {
            InetAddress addr = InetAddress.getByName(host);
            return addr.getHostAddress().equals(host);
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Port of {@code publicSourceUrl}: only a bare public HTTPS URL survives
     * (no credentials, query, fragment, port, IP, or local/internal host).
     * Returns null otherwise.
     */
    public static String publicSourceUrl(String value) {
        if (value == null) {
            return null;
        }
        try {
            URI u = new URI(value);
            if (!"https".equalsIgnoreCase(u.getScheme())) {
                return null;
            }
            if (u.getUserInfo() != null || u.getPort() != -1) {
                return null;
            }
            String host = u.getHost();
            if (host == null || isIp(host) || !HOSTNAME.matcher(host).matches()
                    || LOCAL_SUFFIX.matcher(host).find()
                    || "metadata.google.internal".equalsIgnoreCase(host)) {
                return null;
            }
            // Rebuild without query/fragment; JS keeps the trailing slash form.
            String rebuilt = new URI("https", null, host, -1,
                    u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath(),
                    null, null).toASCIIString();
            return rebuilt.length() <= 4096 ? rebuilt : null;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Port of {@code failureDiagnostic(code, metadata)}: null for an unknown
     * code, otherwise {code, message, http_status, source_url, manifest_id,
     * retryable}.
     */
    public static ObjectNode failureDiagnostic(String code, JsonNode metadata) {
        if (code == null || !MESSAGES.containsKey(code)) {
            return null;
        }
        if (metadata == null || !metadata.isObject()) {
            metadata = Json.MAPPER.createObjectNode();
        }
        Integer httpStatus = null;
        if (("http_error".equals(code) || "website_verification_required".equals(code))
                && metadata.has("http_status") && metadata.path("http_status").isIntegralNumber()) {
            int s = metadata.path("http_status").asInt();
            if (s >= 400 && s <= 599) {
                httpStatus = s;
            }
        }
        boolean retryable = "collection_failed".equals(code)
                || "dns_resolution_failed".equals(code)
                || "retrieval_timeout".equals(code)
                || ("http_error".equals(code)
                && (httpStatus == null || httpStatus == 408 || httpStatus == 429 || httpStatus >= 500));
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.put("code", code);
        out.put("message", MESSAGES.get(code));
        if (httpStatus == null) {
            out.putNull("http_status");
        } else {
            out.put("http_status", httpStatus);
        }
        String sourceUrl = publicSourceUrl(Json.text(metadata, "source_url"));
        if (sourceUrl == null) {
            out.putNull("source_url");
        } else {
            out.put("source_url", sourceUrl);
        }
        String manifestId = Json.text(metadata, "manifest_id");
        if (manifestId != null && MANIFEST_ID.matcher(manifestId).matches()) {
            out.put("manifest_id", manifestId);
        } else {
            out.putNull("manifest_id");
        }
        out.put("retryable", retryable);
        return out;
    }

    /**
     * Port of {@code documentAttempts(collection)}: projects the collector's
     * saved-document records to public metadata.
     */
    public static ArrayNode documentAttempts(JsonNode collection) {
        ArrayNode out = Json.MAPPER.createArrayNode();
        for (JsonNode doc : Json.array(collection, "documents")) {
            boolean saved = "saved".equals(Json.text(doc, "status"));
            String sourceUrl = publicSourceUrl(Json.text(doc, "source_url"));
            String parentUrl = publicSourceUrl(Json.text(doc, "parent_url"));
            String reason = null;
            if (!saved) {
                String code = Json.text(doc, "error_code");
                if (code == null) {
                    code = Json.text(doc, "reason");
                }
                if (code != null && MESSAGES.containsKey(code)) {
                    reason = code;
                } else if (doc.path("http_status").isIntegralNumber()) {
                    reason = "http_error";
                } else if ("SourceBoundaryError".equals(Json.text(doc, "error_type"))) {
                    reason = "source_host_blocked";
                } else if ("gaierror".equals(Json.text(doc, "error_type"))) {
                    reason = "dns_resolution_failed";
                } else if ("TimeoutError".equals(Json.text(doc, "error_type"))) {
                    reason = "retrieval_timeout";
                } else if (Json.text(doc, "reason") != null
                        && Json.text(doc, "reason").toLowerCase().contains("limit reached")) {
                    reason = "resource_limit";
                } else {
                    reason = "collection_failed";
                }
                if ("source_host_blocked".equals(reason)
                        && "Document or redirect is outside the roster site's HTTPS host"
                                .equals(Json.text(doc, "reason"))
                        && (!doc.has("redirects") || !doc.path("redirects").isArray()
                                || doc.path("redirects").isEmpty())
                        && parentUrl != null && sourceUrl != null) {
                    try {
                        if (!new URI(parentUrl).getHost().equalsIgnoreCase(new URI(sourceUrl).getHost())) {
                            reason = "off_host_document_blocked";
                        }
                    } catch (Exception ignored) {
                        // keep source_host_blocked
                    }
                }
            }
            ObjectNode row = Json.MAPPER.createObjectNode();
            if (sourceUrl == null) {
                row.putNull("source_url");
            } else {
                row.put("source_url", sourceUrl);
            }
            if (parentUrl == null) {
                row.putNull("parent_url");
            } else {
                row.put("parent_url", parentUrl);
            }
            if (doc.has("download_attempted") && doc.path("download_attempted").isBoolean()) {
                row.put("download_attempted", doc.path("download_attempted").asBoolean());
            }
            if (doc.has("elapsed_ms") && doc.path("elapsed_ms").isIntegralNumber()
                    && doc.path("elapsed_ms").asLong() >= 0) {
                row.put("elapsed_ms", doc.path("elapsed_ms").asLong());
            }
            if (saved && doc.has("size_bytes") && doc.path("size_bytes").isIntegralNumber()
                    && doc.path("size_bytes").asLong() >= 0) {
                row.put("size_bytes", doc.path("size_bytes").asLong());
            }
            if ("resource_limit".equals(reason)) {
                String limit = Json.text(doc, "limit");
                if (limit != null && java.util.List.of("depth", "pages", "documents", "seconds",
                        "bytes_per_resource", "total_bytes", "network_bytes", "network_requests")
                        .contains(limit)) {
                    row.put("limit", limit);
                }
            }
            row.put("status", saved ? "saved" : "failed");
            if (reason == null) {
                row.putNull("reason");
            } else {
                row.put("reason", reason);
            }
            ObjectNode diag = failureDiagnostic(reason, doc);
            if (diag == null || diag.path("http_status").isNull()) {
                row.putNull("http_status");
            } else {
                row.put("http_status", diag.path("http_status").asInt());
            }
            String sha = Json.text(doc, "sha256");
            if (saved && sha != null && sha.matches("^[0-9a-f]{64}$")) {
                row.put("sha256", sha);
            } else {
                row.putNull("sha256");
            }
            out.add(row);
        }
        return out;
    }
}
