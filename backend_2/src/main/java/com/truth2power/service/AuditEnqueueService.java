package com.truth2power.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.truth2power.config.RepoPaths;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

/**
 * The queue side — port of {@code enqueuePipeline} (pipeline-store.js) and
 * {@code enqueue}/{@code history} (store.js, demo 362 jobs).
 *
 * <p>Validation order and error messages match the old code exactly, because
 * the controllers map them by message: {@code /Idempotency key|Review
 * configuration changed/} → 409, {@code /Invalid/} → 400, anything else →
 * 500 on the v1 route (and every enqueue throw → 400 on the pipeline route).
 * The grading logic itself is never touched — the Node worker claims the job
 * from the same SQLite store and runs it.
 */
@Service
public class AuditEnqueueService {

    private static final Map<String, Long> DISCOVERY_CAPS = Map.of(
            "depth", 8L, "pages", 100L, "documents", 100L,
            "bytes_per_resource", 12582912L, "total_bytes", 134217728L,
            "timeout", 30L, "seconds", 3600L, "redirects", 8L);

    private static final Pattern KEY_64 = Pattern.compile("^[a-f0-9]{64}$");
    private static final Pattern REQUEST_KEY = Pattern.compile("^[A-Za-z0-9-]{1,100}$");
    private static final Pattern DATE = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}$");
    private static final Pattern HOSPITAL_KEY = Pattern.compile("^(?:\\d{1,8}|t2p-\\d+)$");
    private static final Pattern HOSTNAME = Pattern.compile("^[a-z0-9.-]+\\.[a-z]+$", Pattern.CASE_INSENSITIVE);
    private static final Pattern LOCAL_SUFFIX = Pattern.compile("\\.(internal|local|localhost)$",
            Pattern.CASE_INSENSITIVE);

    private final RepoPaths paths;
    private final AuditStore store;
    private final AuditRunService runs;

    private volatile String rubricVersion;
    private volatile String rubricHash;
    private volatile String referenceVersion;
    private volatile String referenceHash;
    private volatile String applicationVisualHash;
    private volatile String applicationProfileHash;

    public AuditEnqueueService(RepoPaths paths, AuditStore store, AuditRunService runs) {
        this.paths = paths;
        this.store = store;
        this.runs = runs;
    }

    private String readHash(String relative, String description) {
        try {
            return Json.sha256Hex(Files.readAllBytes(paths.repoRoot().resolve(relative)));
        } catch (IOException e) {
            throw new IllegalStateException("Could not read " + description, e);
        }
    }

    private void loadHashes() {
        if (rubricHash != null) {
            return;
        }
        synchronized (this) {
            if (rubricHash != null) {
                return;
            }
            try {
                JsonNode rubric = Json.readFile(paths.repoRoot().resolve("rubrics/css-17-v1.json"));
                rubricVersion = Json.text(rubric, "version");
                rubricHash = Json.fingerprint(rubric);
                JsonNode hhs = Json.readFile(
                        paths.repoRoot().resolve("references/hhs-poverty-contiguous-v1.json"));
                referenceVersion = Json.text(hhs, "reference_version");
                referenceHash = readHash("references/hhs-poverty-contiguous-v1.json", "HHS reference");
                applicationVisualHash = readHash("references/application-visual-review-v1.json",
                        "application visual review");
                applicationProfileHash = readHash("references/application-language-profiles-v1.json",
                        "application language profiles");
            } catch (IOException e) {
                throw new IllegalStateException("Could not load audit reference data", e);
            }
        }
    }

    /**
     * Port of {@code facilityFor(key)} (roster-inventory.js): only the
     * roster can supply a network starting point.
     */
    public ObjectNode facilityFor(String key) {
        if (key == null || !HOSPITAL_KEY.matcher(key).matches()) {
            throw new IllegalArgumentException("Unknown hospital key");
        }
        ObjectNode hospital = runs.hospitals().get(key);
        if (hospital == null) {
            throw new IllegalArgumentException("Unknown hospital key");
        }
        String pfi = Json.text(hospital, "pfi");
        String name = Json.text(hospital, "name");
        // assistance_url comes from the geojson feature; re-read it here.
        String assistanceUrl = assistanceUrlFor(key);
        boolean pfiMismatch = pfi != null && !key.equals(pfi);
        if (pfiMismatch || (pfi == null && !key.startsWith("t2p-")) || name == null || name.isBlank()
                || !validAssistanceUrl(assistanceUrl)) {
            throw new IllegalArgumentException("Invalid roster facility or assistance URL");
        }
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.put("hospital_key", key);
        if (pfi == null) {
            out.putNull("pfi");
        } else {
            out.put("pfi", pfi);
        }
        out.put("name", name);
        out.put("landing_url", landingUrl(assistanceUrl));
        return out;
    }

    private String assistanceUrlFor(String key) {
        try {
            JsonNode geo = Json.readFile(paths.mapsDir().resolve("hospitals.geojson"));
            for (JsonNode feature : geo.path("features")) {
                if (key.equals(feature.path("id").asText())) {
                    return Json.text(feature.path("properties"), "assistance_url");
                }
            }
        } catch (IOException e) {
            throw new IllegalStateException("Could not load hospital roster", e);
        }
        return null;
    }

    /** The JS URL normalization for a landing URL (bare https, trailing slash). */
    private static String landingUrl(String value) {
        try {
            URI u = new URI(value);
            String path = u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath();
            return new URI("https", null, u.getHost(), -1, path, null, null).toASCIIString();
        } catch (Exception e) {
            return value;
        }
    }

    private static boolean validAssistanceUrl(String value) {
        if (value == null) {
            return false;
        }
        try {
            URI u = new URI(value);
            if (!"https".equalsIgnoreCase(u.getScheme()) || u.getPort() != -1
                    || u.getUserInfo() != null) {
                return false;
            }
            String host = u.getHost();
            return host != null && !host.contains(":") && HOSTNAME.matcher(host).matches()
                    && !LOCAL_SUFFIX.matcher(host).find()
                    && !"metadata.google.internal".equalsIgnoreCase(host);
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean validReviewDate(String reviewDate, int year) {
        if (reviewDate == null || !DATE.matcher(reviewDate).matches()) {
            return false;
        }
        try {
            LocalDate date = LocalDate.parse(reviewDate);
            return date.toString().equals(reviewDate)
                    && Integer.parseInt(reviewDate.substring(0, 4)) == year;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Port of {@code enqueuePipeline(db, {...})}. The body {@code o} is the
     * parsed JSON request; {@code hospitalKey} is the path key. Returns the
     * job id. Throws IllegalArgumentException with the old code's messages,
     * or AuditBudgets.BudgetStop for the paid unknown-price stop.
     */
    public long enqueuePipeline(Connection db, ObjectNode o, String hospitalKey) throws SQLException {
        loadHashes();
        JsonNode bounds = o.path("discovery_bounds");
        if (bounds.isMissingNode() || bounds.isNull()) {
            bounds = Json.MAPPER.createObjectNode();
        }
        if (!bounds.isObject() || bounds.isArray()) {
            throw new IllegalArgumentException("Invalid discovery bounds");
        }
        for (Map.Entry<String, JsonNode> e : Json.fields(bounds)) {
            Long cap = DISCOVERY_CAPS.get(e.getKey());
            if (cap == null || !e.getValue().isIntegralNumber() || e.getValue().asLong() < 1
                    || e.getValue().asLong() > cap) {
                throw new IllegalArgumentException("Invalid discovery bounds");
            }
        }
        ObjectNode facility = facilityFor(hospitalKey);
        int year = o.path("year").isIntegralNumber() ? o.path("year").asInt() : -1;
        String mode = Json.text(o, "mode");
        String variant = Json.text(o, "variant");
        if (variant == null) {
            variant = "original";
        }
        String requestKey = Json.text(o, "request_key");
        String reviewDate = Json.text(o, "review_date");
        if ((year != 2025 && year != 2026)
                || mode == null || !java.util.List.of("synthetic", "replay", "live", "discovery_only",
                        "full_audit").contains(mode)
                || !java.util.List.of("original", "corrected", "multilingual").contains(variant)
                || requestKey == null || !REQUEST_KEY.matcher(requestKey).matches()
                || !validReviewDate(reviewDate, year)) {
            throw new IllegalArgumentException("Invalid audit job context");
        }
        if ("synthetic".equals(mode) && !"1002".equals(hospitalKey)) {
            throw new IllegalArgumentException("Synthetic fixture is bound to its labeled hospital key 1002");
        }
        String root = store.pipelineRoot().toString();
        ObjectNode context = Json.MAPPER.createObjectNode();
        context.put("pipeline", 1);
        context.put("engine_version", "multilingual-v1");
        context.put("application_visual_sha256", applicationVisualHash);
        context.put("application_profile_sha256", applicationProfileHash);
        context.set("discovery_bounds", bounds);
        context.put("mode", mode);
        context.put("variant", variant);
        context.put("root", root);
        context.put("evidence_root", root);
        context.put("hospital_key", hospitalKey);
        context.put("year", year);
        context.put("review_date", reviewDate);
        context.put("rubric_version", rubricVersion);
        context.put("rubric_sha256", rubricHash);
        context.put("reference_version", referenceVersion);
        context.put("reference_sha256", referenceHash);
        context.put("facility", Json.text(facility, "name"));
        if (!"synthetic".equals(mode)) {
            context.put("roster_sha256", Json.fingerprint(facility));
        }
        String manualImport = Json.text(o, "manual_import");
        if (o.has("manual_import")) {
            if (!"replay".equals(mode) || manualImport == null || !KEY_64.matcher(manualImport).matches()) {
                throw new IllegalArgumentException("Invalid human import");
            }
            context.put("manual_import", manualImport);
        }
        if (o.has("classifications")) {
            // A JSON value can never be a Node Buffer, so the HTTP path always
            // rejects classifications — exactly like the old route.
            throw new IllegalArgumentException("Invalid classification input");
        }
        String reviewConfig = Json.text(o, "review_config");
        if (o.has("review_config")) {
            if (!"full_audit".equals(mode) || reviewConfig == null
                    || !KEY_64.matcher(reviewConfig).matches()) {
                throw new IllegalArgumentException("Invalid reviewer configuration");
            }
            context.put("review_config", reviewConfig);
        }
        JsonNode allowPaidNode = o.path("allow_paid");
        boolean allowPaid = false;
        if (!allowPaidNode.isMissingNode()) {
            if (!allowPaidNode.isBoolean()) {
                throw new IllegalArgumentException("Invalid paid setting");
            }
            allowPaid = allowPaidNode.asBoolean();
        }
        JsonNode budget = o.path("budget");
        if (!budget.isMissingNode() && !budget.isNull()) {
            context.set("requested_budget", budget);
        }
        if (allowPaid) {
            context.put("allow_paid", true);
        }
        String hash = Json.fingerprint(context);
        final boolean finalAllowPaid = allowPaid;
        final JsonNode finalBudget = budget.isMissingNode() || budget.isNull() ? null : budget;
        final String finalReviewConfig = reviewConfig;
        final String finalMode = mode;
        return AuditStore.transaction(db, () -> {
            Long existing = null;
            try (PreparedStatement ps = db.prepareStatement(
                    "SELECT * FROM pipeline_requests WHERE request_key=?")) {
                ps.setString(1, requestKey);
                try (ResultSet rs = ps.executeQuery()) {
                    if (rs.next()) {
                        existing = rs.getLong("job");
                        String oldHash = rs.getString("context_hash");
                        if (!oldHash.equals(hash)) {
                            ObjectNode legacy = context.deepCopy();
                            legacy.remove("roster_sha256");
                            if (!oldHash.equals(Json.fingerprint(legacy))) {
                                throw new IllegalArgumentException(
                                        "Idempotency key already used with different context");
                            }
                        }
                        return existing;
                    }
                }
            }
            if ("live".equals(finalMode) || "full_audit".equals(finalMode)) {
                ObjectNode config = AuditBudgets.agentReviewConfig();
                if (finalReviewConfig != null) {
                    ObjectNode configForHash = Json.MAPPER.createObjectNode();
                    configForHash.put("runtime", Json.text(config, "runtime"));
                    if (Json.text(config, "model") == null) {
                        configForHash.putNull("model");
                    } else {
                        configForHash.put("model", Json.text(config, "model"));
                    }
                    configForHash.put("paid", config.path("paid").asBoolean(false));
                    if (!finalReviewConfig.equals(Json.fingerprint(configForHash))) {
                        throw new IllegalArgumentException("Review configuration changed before confirmation");
                    }
                }
                String runtime = Json.text(config, "runtime");
                boolean paid = config.path("paid").asBoolean(false);
                if (!"offline".equals(runtime) && (!paid || finalAllowPaid)) {
                    ObjectNode agentReview = Json.MAPPER.createObjectNode();
                    agentReview.put("runtime", runtime);
                    if (Json.text(config, "model") == null) {
                        agentReview.putNull("model");
                    } else {
                        agentReview.put("model", Json.text(config, "model"));
                    }
                    agentReview.put("paid", paid);
                    context.set("agent_review", agentReview);
                }
            }
            context.set("budget", AuditBudgets.budgetPolicy(finalBudget, finalAllowPaid));
            long id;
            try (PreparedStatement ps = db.prepareStatement(
                    "INSERT INTO jobs(hospital,year,rule,review_date,context) VALUES(?,?,?,?,?)")) {
                ps.setString(1, hospitalKey);
                ps.setInt(2, year);
                ps.setString(3, "css-17-v1");
                ps.setString(4, reviewDate);
                ps.setString(5, Json.stringify(context));
                ps.executeUpdate();
                try (ResultSet rs = ps.getGeneratedKeys()) {
                    if (!rs.next()) {
                        throw new SQLException("No job id generated");
                    }
                    id = rs.getLong(1);
                }
            }
            try (PreparedStatement ps = db.prepareStatement(
                    "INSERT INTO pipeline_requests VALUES(?,?,?)")) {
                ps.setString(1, requestKey);
                ps.setLong(2, id);
                ps.setString(3, hash);
                ps.executeUpdate();
            }
            pinPrices(db, id);
            if (finalAllowPaid) {
                ObjectNode card = AuditBudgets.configuredPrices();
                if (card.path("models").size() == 0) {
                    throw new AuditBudgets.BudgetStop("unknown_price", "paid_usd_micros");
                }
            }
            AuditStore.event(db, id, null, "queued", Json.MAPPER.createObjectNode());
            return id;
        });
    }

    /** Port of {@code pinPrices(db, job)} (usage-ledger.js). */
    public static void pinPrices(Connection db, long job) throws SQLException {
        try (PreparedStatement ps = db.prepareStatement(
                "INSERT INTO audit_prices VALUES(?,?)")) {
            ps.setLong(1, job);
            ps.setString(2, Json.stringify(AuditBudgets.configuredPrices()));
            ps.executeUpdate();
        }
    }

    /** Port of {@code history(db, hospital)} (store.js): latest demo output. */
    public JsonNode demoHistory(Connection db, String hospital) throws SQLException {
        try (PreparedStatement ps = db.prepareStatement(
                "SELECT a.output FROM assessments a JOIN jobs j ON j.id=a.job "
                        + "WHERE a.hospital=? AND j.rule='application.fpl_guidelines' "
                        + "ORDER BY a.job DESC LIMIT 1")) {
            ps.setString(1, hospital);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    return null;
                }
                return Json.MAPPER.readTree(rs.getString("output"));
            } catch (IOException e) {
                throw new SQLException(e);
            }
        }
    }

    /**
     * Port of {@code enqueue(db, year)} (store.js): the demo 362 job,
     * idempotent per (hospital 362, year, rule) while one is pending.
     */
    public long enqueueDemo(Connection db, int year) throws SQLException {
        return AuditStore.transaction(db, () -> {
            try (PreparedStatement ps = db.prepareStatement(
                    "SELECT id FROM jobs WHERE hospital=? AND year=? AND rule='application.fpl_guidelines' "
                            + "AND status IN ('queued','running')")) {
                ps.setString(1, "362");
                ps.setInt(2, year);
                try (ResultSet rs = ps.executeQuery()) {
                    if (rs.next()) {
                        return rs.getLong("id");
                    }
                }
            }
            JsonNode previous = demoHistory(db, "362");
            ObjectNode context = Json.MAPPER.createObjectNode();
            context.put("site", "Little Falls Hospital");
            context.put("source", "/audit-demo/index.html");
            context.put("scope", "synthetic single-campus fixture");
            context.put("reference", "https://aspe.hhs.gov/poverty-guidelines");
            context.put("rubric", "demo-v1");
            context.put("reference_version", "hhs-" + year + "-contiguous-us");
            context.put("expected_amount", year == 2026 ? 63840 : 62600);
            if (previous == null || previous.path("assessment").path("assessment_id").isMissingNode()) {
                context.putNull("previous_assessment");
            } else {
                context.put("previous_assessment",
                        previous.path("assessment").path("assessment_id").asText());
            }
            ArrayNode priorFindings = Json.MAPPER.createArrayNode();
            if (previous != null) {
                for (JsonNode f : previous.path("assessment").path("findings")) {
                    if ("application.fpl_guidelines".equals(Json.text(f, "measure_id"))) {
                        priorFindings.add(f);
                    }
                }
            }
            context.set("prior_findings", priorFindings);
            ArrayNode corrections = Json.MAPPER.createArrayNode();
            try (PreparedStatement ps = db.prepareStatement(
                    "SELECT note,recorded FROM corrections WHERE hospital=? AND rule=? ORDER BY id")) {
                ps.setString(1, "362");
                ps.setString(2, "application.fpl_guidelines");
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) {
                        ObjectNode row = Json.MAPPER.createObjectNode();
                        row.put("note", rs.getString("note"));
                        row.put("recorded", rs.getString("recorded"));
                        corrections.add(row);
                    }
                }
            }
            context.set("corrections", corrections);
            long id;
            try (PreparedStatement ps = db.prepareStatement(
                    "INSERT INTO jobs(hospital,year,rule,review_date,context) VALUES(?,?,?,?,?)")) {
                ps.setString(1, "362");
                ps.setInt(2, year);
                ps.setString(3, "application.fpl_guidelines");
                ps.setString(4, LocalDate.now(ZoneOffset.UTC).toString());
                ps.setString(5, Json.stringify(context));
                ps.executeUpdate();
                try (ResultSet rs = ps.getGeneratedKeys()) {
                    if (!rs.next()) {
                        throw new SQLException("No job id generated");
                    }
                    id = rs.getLong(1);
                }
            }
            return id;
        });
    }
}
