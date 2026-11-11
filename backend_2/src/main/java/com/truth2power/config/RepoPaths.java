package com.truth2power.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Resolves the repo's data locations. The old Node server resolves them
 * relative to its own source files (repo root); this backend may be started
 * from the repo root or from backend_2/, so the repo root is found by
 * walking up from the working directory until data/maps/hospitals.geojson
 * is found. Explicit configuration always wins:
 * <ul>
 *   <li>{@code t2p.data-dir} / {@code T2P_DATA_DIR} — the repo {@code data/} directory.</li>
 *   <li>{@code t2p.audit-dir} / {@code T2P_REVIEW_DIRECTORY} — the live audit root ({@code .audit/live}).</li>
 *   <li>{@code AUDIT_DIR} — the {@code .audit} directory (its {@code live/} child is the audit root).</li>
 * </ul>
 */
@Component
public class RepoPaths {

    private final Path dataDir;
    private final Path auditLiveDir;
    private final Path auditDir;

    public RepoPaths(
            @Value("${t2p.data-dir:${T2P_DATA_DIR:}}") String dataDirProp,
            @Value("${t2p.audit-dir:${T2P_REVIEW_DIRECTORY:}}") String auditDirProp,
            @Value("${t2p.audit-base:${AUDIT_DIR:}}") String auditBaseProp) {
        Path repoRoot = findRepoRoot();
        this.dataDir = dataDirProp.isBlank()
                ? repoRoot.resolve("data")
                : Path.of(dataDirProp).toAbsolutePath().normalize();
        if (!auditDirProp.isBlank()) {
            this.auditLiveDir = Path.of(auditDirProp).toAbsolutePath().normalize();
            this.auditDir = auditLiveDir.getParent() != null ? auditLiveDir.getParent() : auditLiveDir;
        } else if (!auditBaseProp.isBlank()) {
            this.auditDir = Path.of(auditBaseProp).toAbsolutePath().normalize();
            this.auditLiveDir = auditDir.resolve("live");
        } else {
            this.auditDir = repoRoot.resolve(".audit");
            this.auditLiveDir = auditDir.resolve("live");
        }
    }

    private static Path findRepoRoot() {
        Path dir = Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize();
        for (int i = 0; i < 6 && dir != null; i++) {
            if (Files.isRegularFile(dir.resolve("data/maps/hospitals.geojson"))) return dir;
            dir = dir.getParent();
        }
        // Fall back to the working directory itself; reads will fail loudly there.
        return Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize();
    }

    /** The repo {@code data/} directory (hospitals.geojson, counties.geojson, hospital-coordinates.csv live under {@code maps/}). */
    public Path dataDir() {
        return dataDir;
    }

    /** The live audit root ({@code .audit/live}) — local review records and audit.sqlite live here. */
    public Path auditLiveDir() {
        return auditLiveDir;
    }

    /** The {@code .audit} directory (audit.sqlite lives here). */
    public Path auditDir() {
        return auditDir;
    }

    public Path mapsDir() {
        return dataDir.resolve("maps");
    }

    public Path repoFile(String relative) {
        return dataDir.getParent().resolve(relative);
    }
}
