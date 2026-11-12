package com.truth2power.service;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.truth2power.config.RepoPaths;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Access to the audit store ({@code .audit/audit.sqlite}) — port of
 * backend/audit/store.js {@code openStore()} plus the read-only reporting
 * open in backend/audit/reporting-api.js.
 *
 * <p>Two open modes, mirroring the old app:
 * <ul>
 *   <li>Reporting GETs open the database read-only and never create it: no
 *       {@code audit.sqlite} means an empty history, not an error.</li>
 *   <li>Queue/intervention POSTs open the store read-write, creating the
 *       directory and all tables (including the usage-ledger tables) when
 *       missing, exactly like {@code openStore()}.</li>
 * </ul>
 * The worker (Node) is the other writer; SQLite WAL + {@code busy_timeout}
 * arbitrate. Transactions use explicit {@code BEGIN IMMEDIATE}, like
 * {@code transaction()} in store.js.
 */
@Service
public class AuditStore {

    private static final Logger log = LoggerFactory.getLogger(AuditStore.class);

    private final RepoPaths paths;

    public AuditStore(RepoPaths paths) {
        this.paths = paths;
    }

    /** The {@code .audit} directory (audit.sqlite lives here). */
    public Path auditDir() {
        return paths.auditDir();
    }

    /** The live audit root ({@code .audit/live}) — pipelineRoot() in pipeline-store.js. */
    public Path pipelineRoot() {
        return paths.auditLiveDir();
    }

    public Path dbPath() {
        return auditDir().resolve("audit.sqlite");
    }

    /** Mirrors JS {@code new Date().toISOString()}. */
    public static String now() {
        return Json.toIso(Instant.now());
    }

    /**
     * Read-only reporting open. Returns null when no audit.sqlite exists
     * (empty history). Runs inside a BEGIN read transaction for a consistent
     * snapshot, like reporting-api.js.
     */
    public Connection openReadOnly() throws SQLException {
        Path db = dbPath();
        if (!Files.exists(db)) {
            return null;
        }
        Connection c = DriverManager.getConnection("jdbc:sqlite:file:" + db + "?mode=ro");
        try (Statement s = c.createStatement()) {
            s.execute("PRAGMA busy_timeout = 5000");
            s.execute("BEGIN");
        }
        return c;
    }

    /** Does the (already open) database have the given table? */
    public static boolean hasTable(Connection db, String name) throws SQLException {
        try (PreparedStatement ps = db.prepareStatement(
                "SELECT 1 FROM sqlite_master WHERE name = ?")) {
            ps.setString(1, name);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next();
            }
        }
    }

    /**
     * Reporting fallback for pre-ledger databases: when audit_usage /
     * audit_prices are absent, reporting-api.js creates empty TEMP tables so
     * the receipt queries still run.
     */
    public static void ensureTempLedgerTables(Connection db) throws SQLException {
        if (!hasTable(db, "audit_usage")) {
            try (Statement s = db.createStatement()) {
                s.execute("CREATE TEMP TABLE audit_usage(id,job,attempt,stage,kind,payload,at); "
                        + "CREATE TEMP TABLE audit_prices(job,card)");
            }
        }
    }

    /**
     * Read-write open that creates and migrates the store — port of
     * {@code openStore()} (store.js) + {@code installLedger()}
     * (usage-ledger.js). Callers close the connection.
     */
    public Connection openStore() throws SQLException {
        try {
            Files.createDirectories(auditDir());
        } catch (IOException e) {
            throw new SQLException("Could not create audit directory", e);
        }
        Connection db = DriverManager.getConnection("jdbc:sqlite:" + dbPath());
        try (Statement s = db.createStatement()) {
            s.execute("PRAGMA busy_timeout = 5000");
            s.execute("PRAGMA journal_mode = WAL");
            s.execute("CREATE TABLE IF NOT EXISTS audit_quota(job INTEGER,unit TEXT,"
                    + "used INTEGER NOT NULL,PRIMARY KEY(job,unit))");
            s.execute("CREATE TABLE IF NOT EXISTS paid_reservations(job INTEGER,"
                    + "request_key TEXT,binding TEXT,tokens INTEGER,micros INTEGER,"
                    + "PRIMARY KEY(job,request_key))");
            s.execute("CREATE TABLE IF NOT EXISTS jobs ("
                    + "id INTEGER PRIMARY KEY, hospital TEXT NOT NULL, year INTEGER NOT NULL, "
                    + "rule TEXT NOT NULL, review_date TEXT NOT NULL, context TEXT NOT NULL, "
                    + "status TEXT NOT NULL DEFAULT 'queued', token TEXT, lease INTEGER, "
                    + "checkpoint TEXT, attempted TEXT, error TEXT, attempts INTEGER DEFAULT 0)");
            s.execute("CREATE TABLE IF NOT EXISTS assessments (job INTEGER PRIMARY KEY, "
                    + "hospital TEXT, completed TEXT, output TEXT NOT NULL)");
            s.execute("CREATE INDEX IF NOT EXISTS assessment_history ON assessments(hospital,job)");
            s.execute("CREATE TABLE IF NOT EXISTS extractions (hash TEXT, parser TEXT, "
                    + "observation TEXT, PRIMARY KEY(hash,parser))");
            s.execute("CREATE TABLE IF NOT EXISTS corrections (id INTEGER PRIMARY KEY, "
                    + "hospital TEXT, rule TEXT, note TEXT, recorded TEXT)");
            s.execute("CREATE TABLE IF NOT EXISTS attempts (token TEXT PRIMARY KEY, "
                    + "job INTEGER, started TEXT, status TEXT, error TEXT)");
            s.execute("CREATE TABLE IF NOT EXISTS pipeline_requests (request_key TEXT PRIMARY KEY, "
                    + "job INTEGER NOT NULL, context_hash TEXT NOT NULL)");
            s.execute("CREATE TABLE IF NOT EXISTS audit_run_events ("
                    + "seq INTEGER PRIMARY KEY, job INTEGER NOT NULL, attempt TEXT, "
                    + "state TEXT NOT NULL, at TEXT NOT NULL, detail TEXT NOT NULL)");
            s.execute("CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_run_events "
                    + "BEGIN SELECT RAISE(ABORT,'immutable audit event'); END");
            s.execute("CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_run_events "
                    + "BEGIN SELECT RAISE(ABORT,'immutable audit event'); END");
            s.execute("CREATE INDEX IF NOT EXISTS audit_events_by_job ON audit_run_events(job,seq)");
            s.execute("CREATE INDEX IF NOT EXISTS attempts_by_job ON attempts(job)");
            s.execute("CREATE INDEX IF NOT EXISTS audit_jobs_by_hospital ON jobs(hospital,rule,id)");
            s.execute("CREATE TABLE IF NOT EXISTS pipeline_events (id TEXT PRIMARY KEY, "
                    + "job INTEGER NOT NULL, output TEXT NOT NULL)");
            // installLedger (usage-ledger.js)
            s.execute("CREATE TABLE IF NOT EXISTS audit_prices(job INTEGER PRIMARY KEY, card TEXT NOT NULL)");
            s.execute("CREATE TABLE IF NOT EXISTS audit_usage(id TEXT PRIMARY KEY, job INTEGER NOT NULL, "
                    + "attempt TEXT NOT NULL, stage TEXT NOT NULL, kind TEXT NOT NULL, "
                    + "payload TEXT NOT NULL, at TEXT NOT NULL)");
            s.execute("CREATE INDEX IF NOT EXISTS usage_by_job ON audit_usage(job,attempt)");
            for (String table : new String[]{"audit_prices", "audit_usage"}) {
                for (String op : new String[]{"UPDATE", "DELETE"}) {
                    s.execute("CREATE TRIGGER IF NOT EXISTS immutable_" + table + "_" + op
                            + " BEFORE " + op + " ON " + table
                            + " BEGIN SELECT RAISE(ABORT,'immutable accounting record'); END");
                }
            }
            boolean hasAvailableAt = false;
            try (ResultSet rs = s.executeQuery("PRAGMA table_info(jobs)")) {
                while (rs.next()) {
                    if ("available_at".equals(rs.getString("name"))) {
                        hasAvailableAt = true;
                    }
                }
            }
            if (!hasAvailableAt) {
                s.execute("ALTER TABLE jobs ADD COLUMN available_at INTEGER NOT NULL DEFAULT 0");
            }
        } catch (SQLException e) {
            try {
                db.close();
            } catch (SQLException ignored) {
                // keep the original failure
            }
            throw e;
        }
        return db;
    }

    /** Run {@code body} inside BEGIN IMMEDIATE / COMMIT, ROLLBACK on failure. */
    public static <T> T transaction(Connection db, SqlSupplier<T> body) throws SQLException {
        try (Statement s = db.createStatement()) {
            s.execute("BEGIN IMMEDIATE");
        }
        try {
            T value = body.get();
            try (Statement s = db.createStatement()) {
                s.execute("COMMIT");
            }
            return value;
        } catch (SQLException | RuntimeException e) {
            try (Statement s = db.createStatement()) {
                s.execute("ROLLBACK");
            } catch (SQLException ignored) {
                // keep the original failure
            }
            throw e;
        }
    }

    @FunctionalInterface
    public interface SqlSupplier<T> {
        T get() throws SQLException;
    }

    /** Port of {@code event()} in run-history.js. */
    public static void event(Connection db, long job, String token, String state,
                             ObjectNode detail) throws SQLException {
        try (PreparedStatement ps = db.prepareStatement(
                "INSERT INTO audit_run_events(job,attempt,state,at,detail) VALUES(?,?,?,?,?)")) {
            ps.setLong(1, job);
            if (token == null) {
                ps.setNull(2, java.sql.Types.VARCHAR);
            } else {
                ps.setString(2, token);
            }
            ps.setString(3, state);
            ps.setString(4, now());
            ps.setString(5, Json.stringify(detail));
            ps.executeUpdate();
        }
    }

    /**
     * Port of {@code immutable()} in pipeline-store.js: write a temp file with
     * flag wx, hard-link it to the final name, unlink the temp. An existing
     * target with identical bytes is a reuse; anything else is a collision.
     * (The Node version also meters artifacts_written/storage_bytes, but there
     * is no active meter on the Spring paths that call this, so metering is a
     * no-op here too.)
     */
    public void immutable(String relative, byte[] bytes) throws IOException {
        Path target = pipelineRoot().resolve(relative);
        Files.createDirectories(target.getParent());
        Path temporary = target.resolveSibling(
                target.getFileName() + "." + UUID.randomUUID() + ".tmp");
        Files.write(temporary, bytes, StandardOpenOption.CREATE_NEW);
        try {
            try {
                Files.createLink(target, temporary);
            } catch (java.nio.file.FileAlreadyExistsException e) {
                if (Files.exists(target) && java.util.Arrays.equals(Files.readAllBytes(target), bytes)) {
                    return; // reuse
                }
                throw new IOException("Immutable artifact collision");
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    /** Read an artifact under the live root, bounded like grading/data.js readArtifact. */
    public byte[] readArtifact(String relative) throws IOException {
        return LocalRecords.readBounded(pipelineRoot(), relative);
    }
}
