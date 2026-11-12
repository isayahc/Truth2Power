package com.truth2power.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Port of the usage ledger ({@code readReceipt} in
 * backend/audit/usage-ledger.js) and the public receipt projection
 * ({@code publicReceipt} + {@code csv} in backend/audit/reporting-api.js).
 *
 * <p>Receipts are recomputed from the immutable {@code audit_usage} rows and
 * the rate card pinned at enqueue time. A bill replaces its request estimate.
 * Counts stay integral; money is double, like the JS numbers they mirror.
 */
public final class AuditReceipt {

    private AuditReceipt() {
    }

    private static final List<String> LOCAL_UNITS = List.of("elapsed_ms", "network_bytes", "storage_bytes");
    private static final List<String> TOKENS = List.of("input_tokens", "cached_input_tokens", "output_tokens");
    private static final List<String> KNOWN_STAGES = List.of("prepare", "collect_sources",
            "load_saved_evidence", "extract_documents", "model_review",
            "reconcile_evidence", "grade", "publish");

    private record UsageRow(String id, long job, String attempt, String stage, String kind,
                            ObjectNode payload, String at) {
    }

    /** JSON.stringify([provider, region, usage_id]) — missing values are null. */
    private static String requestKey(ObjectNode p) {
        return "[" + Json.stringify(stringOrNull(p, "provider")) + ","
                + Json.stringify(stringOrNull(p, "region")) + ","
                + Json.stringify(stringOrNull(p, "usage_id")) + "]";
    }

    private static String stringOrNull(ObjectNode p, String field) {
        JsonNode v = p.path(field);
        return v.isTextual() ? v.asText() : null;
    }

    /** Port of {@code readReceipt(db, job)} (usage-ledger.js). Internal shape. */
    public static ObjectNode readReceipt(Connection db, long job) throws SQLException {
        ObjectNode run;
        try (PreparedStatement ps = db.prepareStatement(
                "SELECT status,hospital,json_extract(context,'$.budget') AS budget,"
                        + "json_extract(context,'$.mode') AS mode FROM jobs WHERE id=? AND rule='css-17-v1'")) {
            ps.setLong(1, job);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    throw new IllegalArgumentException("Unknown audit run");
                }
                run = Json.MAPPER.createObjectNode();
                run.put("status", rs.getString("status"));
                run.put("hospital", rs.getString("hospital"));
                String budget = rs.getString("budget");
                run.set("budget", budget == null ? Json.MAPPER.nullNode() : Json.MAPPER.readTree(budget));
                run.put("mode", rs.getString("mode"));
            } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
                throw new SQLException(e);
            }
        }
        JsonNode card = null;
        try (PreparedStatement ps = db.prepareStatement("SELECT card FROM audit_prices WHERE job=?")) {
            ps.setLong(1, job);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next() && rs.getString("card") != null) {
                    card = Json.MAPPER.readTree(rs.getString("card"));
                }
            } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
                throw new SQLException(e);
            }
        }
        List<UsageRow> rows = new ArrayList<>();
        try (PreparedStatement ps = db.prepareStatement(
                "SELECT * FROM audit_usage WHERE job=? ORDER BY rowid")) {
            ps.setLong(1, job);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    JsonNode payload = Json.MAPPER.readTree(rs.getString("payload"));
                    rows.add(new UsageRow(rs.getString("id"), rs.getLong("job"),
                            rs.getString("attempt"), rs.getString("stage"),
                            rs.getString("kind"), (ObjectNode) payload, rs.getString("at")));
                }
            } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
                throw new SQLException(e);
            }
        }

        Map<String, Long> units = new LinkedHashMap<>();
        Map<String, ObjectNode> stages = new LinkedHashMap<>();
        Map<String, Double> nativeBilled = new LinkedHashMap<>();
        List<ObjectNode> unpriced = new ArrayList<>();
        List<String> warnings = new ArrayList<>();
        double calculated = 0, local = 0;
        Double billedUsd = null;
        Set<String> requests = new LinkedHashSet<>();
        Set<String> bills = new LinkedHashSet<>();
        Set<String> usageRecords = new LinkedHashSet<>();
        for (UsageRow row : rows) {
            String key = requestKey(row.payload);
            // Note: JS builds the key from [provider, region, usage_id] with
            // undefined -> null; worker rows get "[null,null,null]" and never
            // match a bill/provider key.
            if ("bill".equals(row.kind)) {
                bills.add(key);
            } else if ("provider".equals(row.kind)) {
                usageRecords.add(key);
            }
        }
        for (UsageRow row : rows) {
            ObjectNode p = row.payload;
            ObjectNode stage = stages.computeIfAbsent(row.stage, name -> {
                ObjectNode s = Json.MAPPER.createObjectNode();
                s.set("units", Json.MAPPER.createObjectNode());
                s.put("calculated_usd", 0.0);
                s.put("estimated_local_usd", 0.0);
                s.set("billed_by_currency", Json.MAPPER.createObjectNode());
                return s;
            });
            ObjectNode stageUnits = (ObjectNode) stage.path("units");
            if ("worker".equals(row.kind)) {
                for (Map.Entry<String, JsonNode> e : Json.fields(p)) {
                    long n = e.getValue().asLong();
                    units.merge(e.getKey(), n, Long::sum);
                    stageUnits.put(e.getKey(), stageUnits.path(e.getKey()).asLong(0) + n);
                    if (n == 0 || !LOCAL_UNITS.contains(e.getKey())) {
                        continue;
                    }
                    JsonNode rate = card == null ? null : card.path("local").path(e.getKey());
                    if (rate == null || rate.isMissingNode() || rate.isNull()) {
                        ObjectNode u = Json.MAPPER.createObjectNode();
                        u.put("id", row.id);
                        u.put("unit", e.getKey());
                        u.put("quantity", n);
                        unpriced.add(u);
                    } else {
                        double amount = rate.asDouble() * n;
                        local += amount;
                        stage.put("estimated_local_usd",
                                stage.path("estimated_local_usd").asDouble() + amount);
                    }
                }
                continue;
            }
            String key = requestKey(p);
            if (!requests.contains(key)) {
                requests.add(key);
                units.merge("paid_model_calls", 1L, Long::sum);
            }
            if ("bill".equals(row.kind)) {
                JsonNode bill = p.path("bill");
                String currency = bill.path("currency").asText();
                double amount = bill.path("amount").asDouble();
                if (!usageRecords.contains(key)) {
                    warnings.add("Provider quantities missing for " + p.path("usage_id").asText());
                }
                nativeBilled.merge(currency, amount, Double::sum);
                ObjectNode byCurrency = (ObjectNode) stage.path("billed_by_currency");
                byCurrency.put(currency, byCurrency.path(currency).asDouble(0) + amount);
                Double fx = "USD".equals(currency) ? 1.0
                        : bill.path("fx").path("usd_per_unit").isNumber()
                                ? bill.path("fx").path("usd_per_unit").asDouble() : null;
                if (fx != null) {
                    billedUsd = (billedUsd == null ? 0.0 : billedUsd) + amount * fx;
                } else {
                    warnings.add("No USD conversion for " + currency + " bill " + p.path("usage_id").asText());
                }
                continue;
            }
            // provider rows
            JsonNode usage = p.path("usage");
            for (String unit : TOKENS) {
                JsonNode nNode = usage.path(unit);
                Long n = nNode.isMissingNode() || nNode.isNull() ? null : nNode.asLong();
                if (n != null) {
                    units.merge(unit, n, Long::sum);
                    stageUnits.put(unit, stageUnits.path(unit).asLong(0) + n);
                }
                if (bills.contains(key) || (n != null && n == 0)) {
                    continue;
                }
                JsonNode rate = null;
                if (card != null) {
                    String modelKey = p.path("provider").asText() + "/" + p.path("region").asText()
                            + "/" + p.path("model").asText();
                    rate = card.path("models").path(modelKey).path(unit);
                    if (rate.isMissingNode() || rate.isNull()) {
                        rate = null;
                    }
                }
                if (rate == null || n == null) {
                    ObjectNode u = Json.MAPPER.createObjectNode();
                    u.put("id", row.id);
                    u.put("unit", unit);
                    if (n == null) {
                        u.putNull("quantity");
                    } else {
                        u.put("quantity", n);
                    }
                    unpriced.add(u);
                } else {
                    double amount = n * rate.asDouble();
                    calculated += amount;
                    stage.put("calculated_usd", stage.path("calculated_usd").asDouble() + amount);
                }
            }
            if (!bills.contains(key)) {
                warnings.add("Provider bill pending for " + p.path("usage_id").asText());
            }
        }

        List<String[]> attempts = new ArrayList<>();
        try (PreparedStatement ps = db.prepareStatement(
                "SELECT token,status FROM attempts WHERE job=? ORDER BY started,rowid")) {
            ps.setLong(1, job);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    attempts.add(new String[]{rs.getString("token"), rs.getString("status")});
                }
            }
        }
        boolean measured = !attempts.isEmpty() && attempts.stream().allMatch(a ->
                ("completed".equals(a[1]) || "failed".equals(a[1]))
                        && rows.stream().anyMatch(r -> r.attempt.equals(a[0]) && "worker".equals(r.kind)
                        && r.payload.path("meter_finished").asInt(0) == 1));
        String status = run.path("status").asText();
        if (!measured || (!"completed".equals(status) && !"failed".equals(status))) {
            warnings.add("Execution or attempt metering incomplete");
        }
        if (units.getOrDefault("telemetry_missing", 0L) > 0) {
            warnings.add("Subprocess usage unavailable");
        }
        boolean zero = measured && requests.isEmpty();
        ObjectNode stopped = null;
        try (PreparedStatement ps = db.prepareStatement(
                "SELECT json_extract(detail,'$.stop_code') code,json_extract(detail,'$.unit') unit "
                        + "FROM audit_run_events WHERE job=? AND state='failed' ORDER BY seq DESC LIMIT 1")) {
            ps.setLong(1, job);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next() && rs.getString("code") != null) {
                    stopped = Json.MAPPER.createObjectNode();
                    stopped.put("code", rs.getString("code"));
                    String unit = rs.getString("unit");
                    if (unit == null) {
                        stopped.putNull("unit");
                    } else {
                        stopped.put("unit", unit);
                    }
                }
            }
        }

        ObjectNode out = Json.MAPPER.createObjectNode();
        out.set("budget", run.path("budget"));
        if (stopped == null) {
            out.putNull("budget_stop");
        } else {
            out.set("budget_stop", stopped);
        }
        out.put("schema_version", "audit-cost-receipt-v1");
        out.put("audit_run_id", "audit-run-" + job);
        out.put("job", job);
        out.put("hospital_key", run.path("hospital").asText());
        out.put("mode", run.path("mode").asText());
        out.put("status", status);
        out.set("rate_card", card == null ? Json.MAPPER.nullNode() : card);
        ArrayNode attemptsNode = Json.MAPPER.createArrayNode();
        for (String[] a : attempts) {
            ObjectNode t = Json.MAPPER.createObjectNode();
            t.put("token", a[0]);
            t.put("status", a[1]);
            attemptsNode.add(t);
        }
        out.set("attempts", attemptsNode);
        ObjectNode stagesNode = Json.MAPPER.createObjectNode();
        for (Map.Entry<String, ObjectNode> e : stages.entrySet()) {
            stagesNode.set(e.getKey(), e.getValue());
        }
        out.set("stages", stagesNode);
        ObjectNode unitsNode = Json.MAPPER.createObjectNode();
        for (Map.Entry<String, Long> e : units.entrySet()) {
            unitsNode.put(e.getKey(), e.getValue());
        }
        out.set("units", unitsNode);
        ArrayNode rowsNode = Json.MAPPER.createArrayNode();
        for (UsageRow r : rows) {
            ObjectNode row = Json.MAPPER.createObjectNode();
            row.put("id", r.id);
            row.put("job", r.job);
            row.put("attempt", r.attempt);
            row.put("stage", r.stage);
            row.put("kind", r.kind);
            row.set("payload", r.payload);
            row.put("at", r.at);
            rowsNode.add(row);
        }
        out.set("rows", rowsNode);
        ObjectNode billedNode = Json.MAPPER.createObjectNode();
        for (Map.Entry<String, Double> e : nativeBilled.entrySet()) {
            billedNode.put(e.getKey(), e.getValue());
        }
        out.set("actual_billed", billedNode);
        if (billedUsd != null) {
            out.put("known_billed_usd", billedUsd);
        } else if (zero) {
            out.put("known_billed_usd", 0);
        } else {
            out.putNull("known_billed_usd");
        }
        out.put("calculated_from_usage_and_pinned_rate", calculated);
        out.put("estimated_local_compute_storage_network", local);
        out.put("estimated_subtotal_usd", local + calculated);
        out.put("zero_incremental_api", zero);
        ArrayNode unpricedNode = Json.MAPPER.createArrayNode();
        for (ObjectNode u : unpriced) {
            unpricedNode.add(u);
        }
        out.set("unknown_unpriced", unpricedNode);
        out.put("complete", warnings.isEmpty() && unpriced.isEmpty());
        ArrayNode warningsNode = Json.MAPPER.createArrayNode();
        for (String w : warnings) {
            warningsNode.add(w);
        }
        out.set("warnings", warningsNode);
        return out;
    }

    /** Port of {@code publicReceipt(db, r)} (reporting-api.js). */
    public static ObjectNode publicReceipt(Connection db, ObjectNode runRow) throws SQLException {
        long job = runRow.path("job_id").asLong();
        ObjectNode c = readReceipt(db, job);
        ObjectNode units = (ObjectNode) c.path("units").deepCopy();
        units.remove("meter_finished");
        units.remove("telemetry_missing");
        ObjectNode stageUsage = Json.MAPPER.createObjectNode();
        ObjectNode stageCosts = Json.MAPPER.createObjectNode();
        JsonNode rateCard = c.path("rate_card");
        for (Map.Entry<String, JsonNode> stageEntry : Json.fields(c.path("stages"))) {
            String name = stageEntry.getKey();
            ObjectNode stage = (ObjectNode) stageEntry.getValue();
            String label = KNOWN_STAGES.contains(name) ? name : "external";
            // NB: check isMissingNode BEFORE casting — path() returns a
            // MissingNode (not null) for an absent label, and casting it throws.
            JsonNode costNode = stageCosts.path(label);
            ObjectNode cost;
            if (costNode.isMissingNode() || !costNode.isObject()) {
                cost = Json.MAPPER.createObjectNode();
                cost.set("billed_by_currency", Json.MAPPER.createObjectNode());
                cost.putNull("estimated_local_usd");
                cost.putNull("calculated_provider_usd");
                stageCosts.set(label, cost);
            } else {
                cost = (ObjectNode) costNode;
            }
            for (Map.Entry<String, JsonNode> e : Json.fields(stage.path("billed_by_currency"))) {
                ObjectNode byCurrency = (ObjectNode) cost.path("billed_by_currency");
                byCurrency.put(e.getKey(), byCurrency.path(e.getKey()).asDouble(0) + e.getValue().asDouble());
            }
            boolean anyLocalUnit = false;
            if (rateCard != null && !rateCard.isNull()) {
                for (Map.Entry<String, JsonNode> e : Json.fields(rateCard.path("local"))) {
                    if (stage.path("units").path(e.getKey()).asLong(0) > 0) {
                        anyLocalUnit = true;
                        break;
                    }
                }
            }
            if (anyLocalUnit) {
                cost.put("estimated_local_usd",
                        cost.path("estimated_local_usd").asDouble(0)
                                + stage.path("estimated_local_usd").asDouble());
            }
            boolean providerPriced = stage.path("calculated_usd").asDouble() > 0;
            if (!providerPriced) {
                for (JsonNode row : c.path("rows")) {
                    if (!name.equals(Json.text(row, "stage")) || !"provider".equals(Json.text(row, "kind"))) {
                        continue;
                    }
                    ObjectNode payload = (ObjectNode) row.path("payload");
                    boolean priced = false;
                    for (Map.Entry<String, JsonNode> e : Json.fields(payload.path("usage"))) {
                        if (e.getValue().asLong(0) > 0 && rateCard != null && !rateCard.isNull()) {
                            String modelKey = Json.text(payload, "provider") + "/"
                                    + Json.text(payload, "region") + "/" + Json.text(payload, "model");
                            JsonNode rate = rateCard.path("models").path(modelKey).path(e.getKey());
                            if (!rate.isMissingNode() && !rate.isNull()) {
                                priced = true;
                                break;
                            }
                        }
                    }
                    if (priced) {
                        providerPriced = true;
                        break;
                    }
                }
            }
            if (providerPriced) {
                cost.put("calculated_provider_usd",
                        cost.path("calculated_provider_usd").asDouble(0)
                                + stage.path("calculated_usd").asDouble());
            }
            JsonNode targetNode = stageUsage.path(label);
            ObjectNode target;
            if (targetNode.isMissingNode() || !targetNode.isObject()) {
                target = Json.MAPPER.createObjectNode();
                stageUsage.set(label, target);
            } else {
                target = (ObjectNode) targetNode;
            }
            for (Map.Entry<String, JsonNode> e : Json.fields(stage.path("units"))) {
                if ("meter_finished".equals(e.getKey()) || "telemetry_missing".equals(e.getKey())) {
                    continue;
                }
                target.put(e.getKey(), target.path(e.getKey()).asLong(0) + e.getValue().asLong());
            }
        }
        boolean localPriced = false;
        for (String k : List.of("storage_bytes", "elapsed_ms", "network_bytes")) {
            if (units.path(k).asLong(0) > 0 && rateCard != null && !rateCard.isNull()
                    && !rateCard.path("local").path(k).isMissingNode()
                    && !rateCard.path("local").path(k).isNull()) {
                localPriced = true;
                break;
            }
        }
        boolean calculatedPriced = false;
        for (JsonNode row : c.path("rows")) {
            if (!"provider".equals(Json.text(row, "kind"))) {
                continue;
            }
            ObjectNode payload = (ObjectNode) row.path("payload");
            for (Map.Entry<String, JsonNode> e : Json.fields(payload.path("usage"))) {
                if (e.getValue().asLong(0) > 0 && rateCard != null && !rateCard.isNull()) {
                    String modelKey = Json.text(payload, "provider") + "/"
                            + Json.text(payload, "region") + "/" + Json.text(payload, "model");
                    JsonNode rate = rateCard.path("models").path(modelKey).path(e.getKey());
                    if (!rate.isMissingNode() && !rate.isNull()) {
                        calculatedPriced = true;
                        break;
                    }
                }
            }
            if (calculatedPriced) {
                break;
            }
        }
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.put("audit_run_id", "audit-run-" + job);
        out.put("hospital_key", runRow.path("hospital_key").asText());
        out.put("mode", runRow.path("mode").asText());
        out.put("status", runRow.path("status").asText());
        out.set("units", units);
        out.set("stage_usage", stageUsage);
        out.set("stage_costs", stageCosts);
        out.set("budget_stop", c.path("budget_stop"));
        boolean complete = c.path("complete").asBoolean(false);
        JsonNode knownBilled = c.path("known_billed_usd");
        boolean costComplete = complete;
        boolean costPartial = !knownBilled.isNull() || localPriced || calculatedPriced
                || c.path("actual_billed").size() > 0;
        out.put("cost_status", costComplete ? "complete" : costPartial ? "partial" : "unknown");
        out.put("complete", complete);
        out.set("known_billed_usd", knownBilled);
        out.set("billed_by_currency", c.path("actual_billed"));
        if (localPriced) {
            out.put("estimated_local_usd", c.path("estimated_local_compute_storage_network").asDouble());
        } else {
            out.putNull("estimated_local_usd");
        }
        if (calculatedPriced) {
            out.put("calculated_provider_usd", c.path("calculated_from_usage_and_pinned_rate").asDouble());
        } else {
            out.putNull("calculated_provider_usd");
        }
        out.put("zero_incremental_api", c.path("zero_incremental_api").asBoolean(false));
        Set<String> unpricedUnits = new LinkedHashSet<>();
        for (JsonNode u : c.path("unknown_unpriced")) {
            unpricedUnits.add(Json.text(u, "unit"));
        }
        ArrayNode unpricedNode = Json.MAPPER.createArrayNode();
        for (String u : unpricedUnits) {
            unpricedNode.add(u);
        }
        out.set("unpriced_units", unpricedNode);
        out.put("warning_count", c.path("warnings").size());
        if (rateCard == null || rateCard.isNull()) {
            out.putNull("price_card_sha256");
        } else {
            out.put("price_card_sha256", Json.fingerprint(rateCard));
        }
        String effectiveDate = rateCard == null ? null : Json.text(rateCard, "effective_date");
        if (effectiveDate != null && effectiveDate.matches("^\\d{4}-\\d{2}-\\d{2}$")) {
            out.put("price_effective_date", effectiveDate);
        } else {
            out.putNull("price_effective_date");
        }
        return out;
    }

    /**
     * Port of {@code csv(receipt)} (reporting-api.js): header row + one data
     * row; object values are quoted JSON; null is an empty cell; CRLF lines.
     * The input must already carry {@code schema_version} first.
     */
    public static String csv(ObjectNode receipt) {
        List<String> fields = new ArrayList<>();
        receipt.fieldNames().forEachRemaining(fields::add);
        StringBuilder out = new StringBuilder();
        out.append(String.join(",", fields)).append("\r\n");
        List<String> cells = new ArrayList<>();
        for (String k : fields) {
            JsonNode v = receipt.path(k);
            String cell = v.isNull() ? ""
                    : v.isObject() || v.isArray() ? Json.stringify(v) : v.asText();
            cells.add("\"" + cell.replace("\"", "\"\"") + "\"");
        }
        out.append(String.join(",", cells)).append("\r\n");
        return out.toString();
    }
}
