package com.truth2power.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Port of backend/audit/budgets.js (budgetPolicy, preview, BudgetStop) plus
 * the review-configuration advertisement from pipeline-store.js
 * ({@code fullAuditReview}) and opencode-transport.js
 * ({@code agentReviewConfig}).
 *
 * <p>Budgets are validated against the configured caps; a paid run requires
 * all three paid limits above zero. The rate card is the operator's
 * {@code T2P_RATE_CARD} file or the default unpriced card.
 */
public final class AuditBudgets {

    private AuditBudgets() {
    }

    /** Port of {@code BudgetStop}: carries a machine code and a unit. */
    public static class BudgetStop extends RuntimeException {
        public final String code;
        public final String unit;

        public BudgetStop(String code, String unit) {
            super(code + " (" + unit + ")");
            this.code = code;
            this.unit = unit;
        }
    }

    public static final Map<String, Long> DEFAULTS = Map.of(
            "network_requests", 600L,
            "network_bytes", 134217728L,
            "pages", 100L,
            "documents", 100L,
            "seconds", 600L,
            "retries", 2L,
            "paid_requests", 0L,
            "paid_tokens", 0L,
            "paid_usd_micros", 0L);

    private static final Map<String, Long> MAXIMA = new LinkedHashMap<>(DEFAULTS);

    static {
        MAXIMA.put("network_requests", 5000L);
        MAXIMA.put("seconds", 3600L);
        MAXIMA.put("paid_requests", 100L);
        MAXIMA.put("paid_tokens", 1000000L);
        MAXIMA.put("paid_usd_micros", 100000000L);
    }

    private static final Pattern VALID_MODEL = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._:/-]{0,126}$");

    private static void validate(JsonNode values, Map<String, Long> ceilings) {
        if (values == null || !values.isObject() || values.isArray()) {
            throw new IllegalArgumentException("Invalid audit budget");
        }
        for (Map.Entry<String, JsonNode> e : Json.fields(values)) {
            Long ceiling = ceilings.get(e.getKey());
            if (ceiling == null || !e.getValue().isIntegralNumber()
                    || e.getValue().asLong() < 0 || e.getValue().asLong() > ceiling) {
                throw new IllegalArgumentException("Invalid audit budget");
            }
        }
    }

    private static Map<String, Long> asLongMap(JsonNode node) {
        Map<String, Long> out = new LinkedHashMap<>();
        if (node != null && node.isObject()) {
            for (Map.Entry<String, JsonNode> e : Json.fields(node)) {
                out.put(e.getKey(), e.getValue().asLong());
            }
        }
        return out;
    }

    /**
     * Port of {@code budgetPolicy(overrides, paid)}: configured caps from
     * {@code T2P_BUDGET_FILE} over the defaults, then the overrides, then the
     * paid rule. Returns the policy object (with a {@code paid} flag).
     */
    public static ObjectNode budgetPolicy(JsonNode overrides, boolean paid) {
        JsonNode configured = Json.MAPPER.createObjectNode();
        String budgetFile = System.getenv("T2P_BUDGET_FILE");
        if (budgetFile != null && !budgetFile.isBlank()) {
            try {
                configured = Json.MAPPER.readTree(Files.readAllBytes(Path.of(budgetFile)));
            } catch (IOException e) {
                throw new IllegalArgumentException("Invalid audit budget", e);
            }
        }
        validate(configured, MAXIMA);
        Map<String, Long> caps = new LinkedHashMap<>(DEFAULTS);
        caps.putAll(asLongMap(configured));
        if (overrides == null) {
            overrides = Json.MAPPER.createObjectNode();
        }
        validate(overrides, caps);
        Map<String, Long> policy = new LinkedHashMap<>(caps);
        policy.putAll(asLongMap(overrides));
        if (paid && (policy.getOrDefault("paid_requests", 0L) == 0
                || policy.getOrDefault("paid_tokens", 0L) == 0
                || policy.getOrDefault("paid_usd_micros", 0L) == 0)) {
            throw new IllegalArgumentException("Invalid paid budget");
        }
        ObjectNode out = Json.MAPPER.createObjectNode();
        for (Map.Entry<String, Long> e : policy.entrySet()) {
            out.put(e.getKey(), e.getValue());
        }
        out.put("paid", paid);
        return out;
    }

    public static ObjectNode budgetPolicy() {
        return budgetPolicy(Json.MAPPER.createObjectNode(), false);
    }

    /** Port of {@code preview(policy, mode)}. */
    public static ObjectNode preview(ObjectNode policy, String mode) {
        if (!java.util.List.of("replay", "synthetic", "full_audit", "live", "discovery_only")
                .contains(mode)) {
            throw new IllegalArgumentException("Invalid audit mode");
        }
        boolean live = java.util.List.of("discovery_only", "full_audit", "live").contains(mode);
        JsonNode rates = configuredPrices().path("local");
        long bytes = live ? policy.path("network_bytes").asLong() : 0;
        Double network = null;
        if (bytes != 0) {
            JsonNode rate = rates.path("network_bytes");
            if (!rate.isMissingNode() && !rate.isNull()) {
                network = bytes * rate.asDouble();
            }
        } else {
            network = 0.0;
        }
        Double compute = null;
        JsonNode elapsedRate = rates.path("elapsed_ms");
        if (!elapsedRate.isMissingNode() && !elapsedRate.isNull()) {
            compute = policy.path("seconds").asLong() * 1000.0 * elapsedRate.asDouble();
        }
        ObjectNode out = Json.MAPPER.createObjectNode();
        if (network == null) {
            out.putNull("network_usd_range");
        } else {
            out.putArray("network_usd_range").add(0).add(network);
        }
        if (compute == null) {
            out.putNull("compute_usd_range");
        } else {
            out.putArray("compute_usd_range").add(0).add(compute);
        }
        out.put("network_requests_max", live ? policy.path("network_requests").asLong() : 0);
        out.put("network_bytes_max", live ? policy.path("network_bytes").asLong() : 0);
        out.putArray("paid_usd_range").add(0)
                .add(policy.path("paid").asBoolean(false)
                        ? policy.path("paid_usd_micros").asLong() / 1e6 : 0);
        out.putNull("local_cost_usd");
        out.put("seconds_max", policy.path("seconds").asLong());
        return out;
    }

    private static void validateRates(JsonNode rates, java.util.List<String> units) {
        if (rates == null || !rates.isObject() || rates.isArray()) {
            throw new IllegalArgumentException("Invalid rates");
        }
        for (Map.Entry<String, JsonNode> e : Json.fields(rates)) {
            if (!units.contains(e.getKey()) || !e.getValue().isNumber()
                    || e.getValue().asDouble() < 0) {
                throw new IllegalArgumentException("Invalid unit price");
            }
        }
    }

    /**
     * Port of {@code configuredPrices()} (usage-ledger.js): the operator's
     * {@code T2P_RATE_CARD} file, or the default unpriced card.
     */
    public static ObjectNode configuredPrices() {
        String file = System.getenv("T2P_RATE_CARD");
        ObjectNode card;
        if (file != null && !file.isBlank()) {
            try {
                JsonNode parsed = Json.MAPPER.readTree(Files.readAllBytes(Path.of(file)));
                if (!parsed.isObject()) {
                    throw new IllegalArgumentException("Invalid USD rate card");
                }
                card = (ObjectNode) parsed;
            } catch (IOException e) {
                throw new IllegalArgumentException("Invalid USD rate card", e);
            }
        } else {
            card = Json.MAPPER.createObjectNode();
            card.put("version", "unpriced-v1");
            card.putNull("effective_date");
            card.put("currency", "USD");
            card.set("local", Json.MAPPER.createObjectNode());
            card.set("models", Json.MAPPER.createObjectNode());
        }
        String version = Json.text(card, "version");
        String effectiveDate = Json.text(card, "effective_date");
        if (version == null || version.isBlank() || !"USD".equals(Json.text(card, "currency"))
                || (file != null && (effectiveDate == null
                        || !effectiveDate.matches("^\\d{4}-\\d{2}-\\d{2}$")))
                || !card.path("local").isObject() || card.path("local").isArray()
                || !card.path("models").isObject() || card.path("models").isArray()) {
            throw new IllegalArgumentException("Invalid USD rate card");
        }
        validateRates(card.path("local"), java.util.List.of("elapsed_ms", "network_bytes", "storage_bytes"));
        for (JsonNode rates : card.path("models")) {
            validateRates(rates, java.util.List.of("input_tokens", "cached_input_tokens", "output_tokens"));
        }
        return card;
    }

    private static boolean freeModel(String model) {
        return "openrouter/free".equals(model) || model.endsWith(":free");
    }

    /**
     * Port of {@code agentReviewConfig()} (opencode-transport.js): env-driven;
     * offline unless a local model or an OpenRouter model/key is configured.
     */
    public static ObjectNode agentReviewConfig() {
        String local = trimOrNull(System.getenv("T2P_OPENCODE_LOCAL_MODEL"));
        String model = local != null ? local : trimOrNull(System.getenv("T2P_OPENROUTER_MODEL"));
        if (model == null && System.getenv("OPENROUTER_API_KEY") != null) {
            model = "openrouter/free";
        }
        ObjectNode out = Json.MAPPER.createObjectNode();
        if (model == null) {
            out.put("runtime", "offline");
            out.putNull("model");
            out.put("paid", false);
            return out;
        }
        if (!VALID_MODEL.matcher(model).matches() || model.contains("..")) {
            throw new IllegalArgumentException("Invalid audit model ID");
        }
        out.put("runtime", local != null ? "opencode" : "openrouter");
        out.put("model", model);
        out.put("paid", local == null && !freeModel(model));
        return out;
    }

    private static String trimOrNull(String value) {
        if (value == null) {
            return null;
        }
        String t = value.trim();
        return t.isEmpty() ? null : t;
    }

    /**
     * Port of {@code fullAuditReview()} (pipeline-store.js): advertise only
     * the review configuration the server can actually queue.
     */
    public static ObjectNode fullAuditReview() {
        ObjectNode config = agentReviewConfig();
        ObjectNode limits = budgetPolicy();
        ObjectNode rates = null;
        if (config.path("paid").asBoolean(false)) {
            JsonNode models = configuredPrices().path("models");
            rates = (ObjectNode) models.path("openrouter/global/" + Json.text(config, "model"));
        }
        boolean available = !config.path("paid").asBoolean(false)
                || (limits.path("paid_requests").asLong() > 0
                && limits.path("paid_tokens").asLong() > 0
                && limits.path("paid_usd_micros").asLong() > 0
                && rates != null && rates.path("input_tokens").isNumber()
                && rates.path("output_tokens").isNumber());
        ObjectNode out = config.deepCopy();
        out.put("available", available);
        out.put("config_id", Json.fingerprint(config));
        out.put("max_paid_usd", available && config.path("paid").asBoolean(false)
                ? limits.path("paid_usd_micros").asLong() / 1e6 : 0);
        return out;
    }
}
