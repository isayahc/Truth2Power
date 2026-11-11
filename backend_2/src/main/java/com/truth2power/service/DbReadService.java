package com.truth2power.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.truth2power.model.County;
import com.truth2power.model.DatasetMeta;
import com.truth2power.model.Hospital;
import com.truth2power.repository.CountyRepository;
import com.truth2power.repository.DatasetMetaRepository;
import com.truth2power.repository.HospitalRepository;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

/**
 * The TiDB-backed read path, used only when {@code t2p.reads-from-db} is true
 * and the JPA repositories exist (the tidb profile). In the default profile
 * there is no datasource, so the providers are empty and every method here
 * reports unavailable — the controllers then fall back to the file reads.
 * Only the roster-shaped reads are DB-backed: /api/hospitals is rebuilt from
 * the stored source features, and /api/overview takes its roster and
 * county→region map from the tables. /api/counties stays file-backed (the
 * counties table stores no geometry), and the live-audit fields in the
 * overview still come from HospitalPageService, which reads .audit state.
 */
@Service
public class DbReadService {

    private final ObjectProvider<HospitalRepository> hospitals;
    private final ObjectProvider<CountyRepository> counties;
    private final ObjectProvider<DatasetMetaRepository> datasetMeta;

    public DbReadService(ObjectProvider<HospitalRepository> hospitals,
                         ObjectProvider<CountyRepository> counties,
                         ObjectProvider<DatasetMetaRepository> datasetMeta) {
        this.hospitals = hospitals;
        this.counties = counties;
        this.datasetMeta = datasetMeta;
    }

    public boolean dbAvailable() {
        return hospitals.getIfAvailable() != null && counties.getIfAvailable() != null;
    }

    /** Rebuilds hospitals.geojson from the stored per-feature JSON, roster order. */
    public byte[] hospitalsJson() {
        ObjectNode out = Json.MAPPER.createObjectNode();
        out.put("type", "FeatureCollection");
        DatasetMetaRepository meta = datasetMeta.getIfAvailable();
        if (meta != null) {
            meta.findById("hospitals.name").ifPresent(m -> out.put("name", m.getValue()));
            meta.findById("hospitals.attribution").ifPresent(m -> out.put("attribution", m.getValue()));
        }
        ArrayNode features = Json.MAPPER.createArrayNode();
        for (Hospital h : hospitals.getObject().findAllByOrderBySortOrderAsc()) {
            try {
                features.add(Json.MAPPER.readTree(h.getSourceFeatureJson()));
            } catch (Exception e) {
                throw new IllegalStateException("Stored hospital feature could not be parsed", e);
            }
        }
        out.set("features", features);
        return Json.stringify(out).getBytes(StandardCharsets.UTF_8);
    }

    /** The roster features, parsed from the stored JSON, for the DB overview. */
    public List<JsonNode> rosterFeatures() {
        List<JsonNode> out = new ArrayList<>();
        for (Hospital h : hospitals.getObject().findAllByOrderBySortOrderAsc()) {
            try {
                out.add(Json.MAPPER.readTree(h.getSourceFeatureJson()));
            } catch (Exception e) {
                throw new IllegalStateException("Stored hospital feature could not be parsed", e);
            }
        }
        return out;
    }

    /** county → region, keyed the same way OverviewService keys its map. */
    public Map<String, String> regionByCounty() {
        Map<String, String> out = new LinkedHashMap<>();
        for (County c : counties.getObject().findAll()) {
            if (c.getRegion() != null) {
                out.put(countyKey(c.getName()), c.getRegion());
            }
        }
        return out;
    }

    private static String countyKey(String name) {
        return name == null ? "" : name.replace(".", "").toLowerCase(java.util.Locale.ROOT);
    }
}
