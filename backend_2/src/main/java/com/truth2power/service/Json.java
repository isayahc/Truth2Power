package com.truth2power.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * JSON and hashing helpers that mirror the Node backend's exact behaviour:
 * <ul>
 *   <li>{@code JSON.stringify} — compact, no spaces, insertion-ordered keys.</li>
 *   <li>{@code Date.toISOString()} — always {@code yyyy-MM-dd'T'HH:mm:ss.SSS'Z'}.</li>
 *   <li>{@code fingerprint} — sha256 of the canonical (recursively key-sorted) JSON.</li>
 * </ul>
 */
public final class Json {
    public static final ObjectMapper MAPPER = new ObjectMapper();

    private static final DateTimeFormatter ISO_MILLIS =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    private Json() {}

    public static JsonNode readFile(Path path) throws IOException {
        return MAPPER.readTree(Files.readAllBytes(path));
    }

    public static String stringify(Object value) {
        try {
            return MAPPER.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("JSON serialization failed", e);
        }
    }

    public static String sha256Hex(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    public static String sha256Hex(String text) {
        return sha256Hex(text.getBytes(StandardCharsets.UTF_8));
    }

    /** Recursively sort object keys, mirroring grading/data.js {@code canonical}. */
    public static JsonNode canonical(JsonNode value) {
        if (value.isArray()) {
            ArrayNode out = MAPPER.createArrayNode();
            for (JsonNode item : value) out.add(canonical(item));
            return out;
        }
        if (value.isObject()) {
            List<String> keys = new ArrayList<>();
            value.fieldNames().forEachRemaining(keys::add);
            keys.sort(String::compareTo);
            ObjectNode out = MAPPER.createObjectNode();
            for (String key : keys) out.set(key, canonical(value.get(key)));
            return out;
        }
        return value;
    }

    /** sha256(JSON.stringify(canonical(value))) — grading/data.js {@code fingerprint}. */
    public static String fingerprint(JsonNode value) {
        return sha256Hex(stringify(canonical(value)));
    }

    public static String fingerprint(Object value) {
        return fingerprint(MAPPER.valueToTree(value));
    }

    /** Mirrors JS {@code Date.toISOString()}: always three-digit millis + Z. */
    public static String toIso(Instant instant) {
        return ISO_MILLIS.format(instant);
    }

    /** Mirrors JS {@code validDate}: a string Date.parse can read. */
    public static boolean validDate(JsonNode value) {
        if (value == null || !value.isTextual()) return false;
        try {
            Instant.parse(normalizeIso(value.asText()));
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    public static boolean validDate(String value) {
        if (value == null) return false;
        try {
            Instant.parse(normalizeIso(value));
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** Parse an ISO date the way JS Date.parse does (accepts +00:00 offsets and date-only forms). */
    public static Instant parseDate(String value) {
        return Instant.parse(normalizeIso(value));
    }

    private static String normalizeIso(String value) {
        String v = value.trim();
        if (v.matches("\\d{4}-\\d{2}-\\d{2}")) return v + "T00:00:00Z";
        if (v.endsWith("Z")) return v;
        // Offset like +00:00 — Instant.parse handles it; date-only with time needs no fix.
        return v;
    }

    public static String text(JsonNode node, String field) {
        JsonNode v = node == null ? null : node.get(field);
        return v != null && v.isTextual() ? v.asText() : null;
    }

    public static String textOr(JsonNode node, String field, String fallback) {
        String v = text(node, field);
        return v != null ? v : fallback;
    }

    public static List<JsonNode> array(JsonNode node, String field) {
        JsonNode v = node == null ? null : node.get(field);
        if (v == null || !v.isArray()) return List.of();
        List<JsonNode> out = new ArrayList<>();
        v.forEach(out::add);
        return out;
    }

    public static Map<String, Object> linkedMap(Object... keyValues) {
        Map<String, Object> map = new java.util.LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) {
            map.put((String) keyValues[i], keyValues[i + 1]);
        }
        return map;
    }

    /** Iterate object fields in insertion order (the file's key order). */
    public static Iterable<Map.Entry<String, JsonNode>> fields(JsonNode object) {
        return () -> object.fields();
    }
}
