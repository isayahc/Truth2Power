package com.truth2power.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.net.URI;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Port of backend/review/identity.js — resolves which saved hospital
 * documents a producer assessment actually reviewed, from collection
 * metadata, excluding reference forms and derived renders.
 */
public final class ReviewIdentity {

    private static final Pattern HASH64 = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern LANG_TAG = Pattern.compile("^[a-z]{2,3}(-[a-z0-9]{2,8})*$");
    private static final Set<String> ROLES = Set.of("application", "landing_page", "policy_summary",
            "policy_statement", "supplement", "online_application");
    private static final Map<String, String> LANGUAGES = Map.of(
            "english", "en", "spanish", "es", "polish", "pl", "ukrainian", "uk",
            "russian", "ru", "unknown", "und", "unverified", "und", "undetermined", "und");
    private static final Map<String, String> SCOPES = Map.of(
            "application-reviews", "selected_application", "full-reviews", "posted_materials");

    private ReviewIdentity() {}

    /** Preserve path and query identity, normalizing only URL syntax and fragment. */
    public static String sourceUrl(String value) {
        if (value == null || !value.matches("(?i)^https?://.*") || value.length() > 4096
                || value.chars().anyMatch(c -> Character.isWhitespace(c) || c == '\\' || c < 0x20)) {
            throw new IllegalArgumentException("Invalid source URL");
        }
        URI uri;
        try {
            uri = new URI(value);
        } catch (Exception e) {
            throw new IllegalArgumentException("Invalid source URL");
        }
        String scheme = uri.getScheme() == null ? null : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!"https".equals(scheme) && !"http".equals(scheme)) throw new IllegalArgumentException("Invalid source URL");
        if (uri.getUserInfo() != null) throw new IllegalArgumentException("Invalid source URL");
        String host = uri.getHost() == null ? null : uri.getHost().toLowerCase(Locale.ROOT);
        int port = uri.getPort();
        String path = uri.getRawPath() == null || uri.getRawPath().isEmpty() ? "/" : uri.getRawPath();
        StringBuilder out = new StringBuilder().append(scheme).append("://").append(host);
        if (port != -1 && port != ("https".equals(scheme) ? 443 : 80)) out.append(':').append(port);
        out.append(path);
        if (uri.getRawQuery() != null) out.append('?').append(uri.getRawQuery());
        return out.toString();
    }

    public static String languageTag(JsonNode value) {
        if (value == null || !value.isTextual() || value.asText().isBlank()) return "und";
        String label = value.asText().toLowerCase(Locale.ROOT).trim();
        if (LANGUAGES.containsKey(label)) return LANGUAGES.get(label);
        if (!LANG_TAG.matcher(label).matches()) return "und";
        try {
            return Locale.forLanguageTag(label).toLanguageTag();
        } catch (Exception e) {
            return "und";
        }
    }

    private static String safeSourceUrl(JsonNode node, String field) {
        JsonNode v = node == null ? null : node.get(field);
        if (v == null || !v.isTextual()) throw new IllegalArgumentException("Invalid source URL");
        return sourceUrl(v.asText());
    }

    private static List<JsonNode> nodeList(JsonNode node) {
        List<JsonNode> out = new ArrayList<>();
        if (node != null && node.isArray()) node.forEach(out::add);
        return out;
    }

    private static Object sortedKeys(JsonNode node) {
        List<String> keys = new ArrayList<>();
        node.fieldNames().forEachRemaining(keys::add);
        keys.sort(String::compareTo);
        return String.join(",", keys);
    }

    /**
     * Mirrors reviewIdentity(result, namespace, resultHash). Returns a map with
     * group, scope, identity_status, documents and optionally identity_warning.
     * On ambiguous legacy input it returns the ambiguous_legacy shape instead
     * of throwing (unless a declared identity was supplied — then it throws).
     */
    public static Map<String, Object> reviewIdentity(JsonNode result, String namespace, String resultHash) {
        JsonNode declared = result == null ? null : result.get("review_identity");
        String scope = SCOPES.get(namespace);
        List<Map<String, Object>> docs = new ArrayList<>();
        try {
            JsonNode coverageNode = result == null ? null : result.get("coverage");
            if (coverageNode == null || !coverageNode.isArray()) throw new IllegalArgumentException("Ambiguous source coverage");
            List<JsonNode> coverage = nodeList(coverageNode);
            if ("application-reviews".equals(namespace) && coverage.size() != 1) {
                List<JsonNode> selected = new ArrayList<>();
                for (JsonNode c : coverage) {
                    if ("application".equals(Json.text(c, "source_id"))) selected.add(c);
                }
                if (!selected.isEmpty() || declared != null) {
                    coverage = selected;
                } else {
                    List<JsonNode> filtered = new ArrayList<>();
                    List<JsonNode> snapshots = nodeList(result.get("snapshots"));
                    for (JsonNode c : coverage) {
                        String sid = Json.text(c, "source_id");
                        if ("official_reference".equals(sid) || "reference_visual_review".equals(sid)
                                || "application_visual_review".equals(sid)) continue;
                        boolean matches = false;
                        for (JsonNode s : snapshots) {
                            if ("application".equals(Json.text(s, "document_type"))) {
                                try {
                                    if (sourceUrl(Json.text(s, "url")).equals(sourceUrl(Json.text(c, "url")))) {
                                        matches = true;
                                        break;
                                    }
                                } catch (IllegalArgumentException ignored) {
                                }
                            }
                        }
                        if (matches) filtered.add(c);
                    }
                    coverage = filtered;
                }
            }
            if (scope == null || coverage.isEmpty()
                    || ("application-reviews".equals(namespace) && coverage.size() != 1)) {
                throw new IllegalArgumentException("Ambiguous source coverage");
            }
            if (declared != null && (declared.path("version").asInt(-1) != 1
                    || !scope.equals(Json.text(declared, "scope"))
                    || !declared.has("documents") || !declared.get("documents").isArray()
                    || !"documents,scope,version".equals(sortedKeys(declared))
                    || declared.get("documents").size() != coverage.size())) {
                throw new IllegalArgumentException("Invalid review identity");
            }
            List<JsonNode> snapshots = nodeList(result.get("snapshots"));
            for (int index = 0; index < coverage.size(); index++) {
                JsonNode entry = coverage.get(index);
                String url = sourceUrl(Json.text(entry, "url"));
                List<JsonNode> candidates = new ArrayList<>();
                for (JsonNode s : snapshots) {
                    boolean sameUrl;
                    try {
                        sameUrl = sourceUrl(Json.text(s, "url")).equals(url);
                    } catch (IllegalArgumentException e) {
                        continue;
                    }
                    if (!sameUrl || s.has("derived_from_snapshot_id")) continue;
                    JsonNode entrySha = entry.get("snapshot_sha256");
                    if (entrySha != null && entrySha.isTextual()
                            && !entrySha.asText().equals(Json.text(s, "sha256"))) continue;
                    JsonNode entryId = entry.get("snapshot_id");
                    if (entryId != null && entryId.isTextual()
                            && !entryId.asText().equals(Json.text(s, "snapshot_id"))) continue;
                    if ("selected_application".equals(scope) && !"application".equals(Json.text(s, "document_type"))) continue;
                    candidates.add(s);
                }
                JsonNode source = candidates.isEmpty() ? null : candidates.get(0);
                if (source == null || !HASH64.matcher(Json.text(source, "sha256") == null ? "" : Json.text(source, "sha256")).matches()
                        || !ROLES.contains(Json.text(source, "document_type"))
                        || candidates.stream().anyMatch(s -> !Json.text(s, "sha256").equals(Json.text(source, "sha256"))
                                || !Json.text(s, "document_type").equals(Json.text(source, "document_type")))) {
                    throw new IllegalArgumentException("Ambiguous snapshot");
                }
                String language = languageTag(entry.get("language"));
                if (declared != null) {
                    String snapshotId = Json.text(source, "snapshot_id");
                    String sha = Json.text(source, "sha256");
                    String artifactPath = Json.text(source, "artifact_path");
                    boolean artifactOk = "pdf".equals(extOf(artifactPath, sha)) || "html".equals(extOf(artifactPath, sha))
                            || "docx".equals(extOf(artifactPath, sha));
                    if (!sha.equals(snapshotId) || !artifactOk) {
                        throw new IllegalArgumentException("Invalid declared snapshot reference");
                    }
                    JsonNode d = declared.get("documents").get(index);
                    if (d == null || !"language,role,snapshot_sha256,url".equals(sortedKeys(d))
                            || !Json.text(d, "url").equals(Json.text(entry, "url"))
                            || !Json.text(d, "role").equals(Json.text(source, "document_type"))
                            || !Json.text(d, "snapshot_sha256").equals(sha)
                            || Json.text(d, "language") == null || Json.text(d, "language").isBlank()
                            || Json.text(d, "language").length() > 100
                            || !Json.text(d, "language").equals(Json.text(entry, "language"))) {
                        throw new IllegalArgumentException("Identity differs from saved coverage");
                    }
                }
                String name = Json.text(source, "display_name");
                if (name == null || name.isBlank()) {
                    try {
                        String p = new URI(url).getPath();
                        name = p == null || p.isEmpty() ? url : p.substring(p.lastIndexOf('/') + 1);
                        if (name.isEmpty()) name = url;
                    } catch (Exception e) {
                        name = url;
                    }
                }
                Map<String, Object> doc = new LinkedHashMap<>();
                doc.put("source_id", url);
                doc.put("snapshot_sha256", Json.text(source, "sha256"));
                doc.put("role", Json.text(source, "document_type"));
                doc.put("language", language);
                doc.put("language_label", Json.text(entry, "language") == null ? "unknown" : Json.text(entry, "language"));
                doc.put("name", name);
                docs.add(doc);
            }
            if ("posted_materials".equals(scope)) {
                for (JsonNode s : snapshots) {
                    boolean covered = false;
                    for (Map<String, Object> d : docs) {
                        try {
                            if (d.get("source_id").equals(sourceUrl(Json.text(s, "url")))
                                    && d.get("role").equals(Json.text(s, "document_type"))
                                    && d.get("snapshot_sha256").equals(Json.text(s, "sha256"))) {
                                covered = true;
                                break;
                            }
                        } catch (IllegalArgumentException ignored) {
                        }
                    }
                    if (!covered) throw new IllegalArgumentException("Uncovered snapshot in source identity");
                }
            }
            boolean unversionedRun = declared == null && (result.get("rubric_version") == null || result.get("rubric_version").isNull());
            if (!unversionedRun) {
                String rv = Json.text(result, "rubric_version");
                if (rv == null || rv.isBlank()) throw new IllegalArgumentException("Missing rubric version");
            }
            JsonNode gy = result.get("guideline_year");
            if (gy != null && !gy.isNull() && (!gy.isIntegralNumber() || gy.asInt() < 2000)) {
                throw new IllegalArgumentException("Invalid guideline year");
            }
            JsonNode refV = result.get("reference_version");
            if (refV != null && !refV.isNull()) {
                String rv = Json.text(result, "reference_version");
                if (rv == null || rv.isBlank()) throw new IllegalArgumentException("Invalid reference version");
            }
            Map<String, Map<String, Object>> unique = new LinkedHashMap<>();
            for (Map<String, Object> doc : docs) {
                List<Object> parts = new ArrayList<>(List.of(doc.get("source_id"), doc.get("role"), doc.get("language")));
                String langLabel = ((String) doc.get("language_label")).trim().toLowerCase(Locale.ROOT);
                if ("und".equals(doc.get("language"))
                        && !Set.of("und", "unknown", "unverified", "undetermined").contains(langLabel)) {
                    parts.add(((String) doc.get("language_label")).trim());
                }
                String key = Json.stringify(parts);
                if (unique.containsKey(key)
                        && !unique.get(key).get("snapshot_sha256").equals(doc.get("snapshot_sha256"))) {
                    throw new IllegalArgumentException("Conflicting source versions");
                }
                unique.put(key, doc);
            }
            List<String> keys = new ArrayList<>(unique.keySet());
            keys.sort(String::compareTo);
            List<Object> groupInput = new ArrayList<>();
            groupInput.add(Json.text(result, "hospital_key"));
            groupInput.add(namespace);
            groupInput.add(scope);
            if (unversionedRun) {
                groupInput.add(List.of("legacy_run", Json.text(result, "review_id")));
            } else {
                groupInput.add(Json.text(result, "rubric_version"));
            }
            groupInput.add(gy == null || gy.isNull() ? null : gy.asInt());
            groupInput.add(refV == null || refV.isNull() ? null : refV.asText());
            groupInput.add(keys);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("group", Json.fingerprint(groupInput));
            out.put("scope", scope);
            out.put("identity_status", unversionedRun ? "legacy_unversioned_run" : declared != null ? "declared" : "derived_legacy");
            if (unversionedRun) {
                out.put("identity_warning", "Rubric unknown. Revisions are grouped only within the original review run.");
            }
            List<Map<String, Object>> orderedDocs = new ArrayList<>();
            for (String k : keys) orderedDocs.add(unique.get(k));
            out.put("documents", orderedDocs);
            return out;
        } catch (RuntimeException error) {
            if (declared != null) throw error;
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("group", resultHash);
            out.put("scope", scope);
            out.put("identity_status", "ambiguous_legacy");
            out.put("documents", List.of());
            out.put("identity_warning", error.getMessage());
            return out;
        }
    }

    private static String extOf(String artifactPath, String sha) {
        if (artifactPath == null || sha == null) return null;
        String prefix = "snapshots/" + sha + ".";
        if (!artifactPath.startsWith(prefix)) return null;
        return artifactPath.substring(prefix.length());
    }
}
