package com.truth2power.service;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.truth2power.config.RepoPaths;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.springframework.stereotype.Service;

/**
 * Port of backend/changes/routes.js — the change feed over saved captures.
 * GET /api/changes replays the saved captures by running the same Python
 * script the old app runs (tools/live-audit/changes.py, 60 s timeout) and
 * prepends the stored pipeline events from audit.sqlite. Snapshots and the
 * two pre-loaded posting assessments are served hash-verified, exactly as
 * the old route serves them.
 */
@Service
public class ChangesService {

    private static final int MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

    private final Path root;
    private final Path auditDir;
    private final Path script;
    private final Map<String, byte[]> assessments = new HashMap<>();

    public ChangesService(RepoPaths paths) throws IOException {
        this.root = paths.auditLiveDir();
        this.auditDir = paths.auditDir();
        this.script = paths.repoFile("tools/live-audit/changes.py");
        for (String rel : List.of("docs/audit-format/posting/362.json",
                "docs/audit-format/changes/362-summary-posting.json")) {
            Path file = paths.repoFile(rel);
            if (Files.exists(file)) {
                byte[] bytes = Files.readAllBytes(file);
                assessments.put(Json.sha256Hex(bytes), bytes);
            }
        }
    }

    public ObjectNode feed() throws IOException {
        String python = System.getenv("T2P_PYTHON");
        if (python == null || python.isBlank()) {
            python = "python3";
        }
        ProcessBuilder builder = new ProcessBuilder(python, script.toString(),
                "--root", root.toString());
        builder.redirectErrorStream(false);
        Process process;
        try {
            process = builder.start();
        } catch (IOException e) {
            throw new IllegalStateException("Could not replay the saved captures.", e);
        }
        // Drain stderr on a separate thread so a chatty child cannot deadlock us.
        Thread stderrDrain = new Thread(() -> {
            try (InputStream err = process.getErrorStream()) {
                err.transferTo(java.io.OutputStream.nullOutputStream());
            } catch (IOException ignored) {
            }
        });
        stderrDrain.setDaemon(true);
        stderrDrain.start();
        byte[] stdout;
        try (InputStream in = process.getInputStream()) {
            stdout = readBounded(in, MAX_OUTPUT_BYTES);
        }
        boolean finished;
        try {
            finished = process.waitFor(60, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            process.destroyForcibly();
            throw new IllegalStateException("Could not replay the saved captures.", e);
        }
        if (!finished) {
            process.destroyForcibly();
            throw new IllegalStateException("Could not replay the saved captures.");
        }
        if (process.exitValue() != 0) {
            throw new IllegalStateException("Could not replay the saved captures.");
        }
        ObjectNode data;
        try {
            data = (ObjectNode) Json.MAPPER.readTree(stdout);
        } catch (IOException e) {
            throw new IllegalStateException("Could not replay the saved captures.", e);
        }
        ArrayNode events = Json.MAPPER.createArrayNode();
        for (ObjectNode event : PipelineViews.pipelineEvents(auditDir, root)) {
            events.add(event);
        }
        for (com.fasterxml.jackson.databind.JsonNode event : Json.array(data, "events")) {
            events.add(event);
        }
        data.set("events", events);
        return data;
    }

    public byte[] assessment(String sha256) {
        return assessments.get(sha256);
    }

    public record SnapshotResult(byte[] raw, String filename) {
    }

    /** Returns the snapshot bytes, or throws with the mapped HTTP status. */
    public SnapshotResult snapshot(String sha256, String extension) throws IOException {
        String filename = sha256 + "." + extension;
        byte[] raw;
        try {
            raw = LocalRecords.readBounded(root, "snapshots/" + filename);
        } catch (IOException e) {
            throw new ChangesException(404, "Original snapshot unavailable.");
        }
        if (!Json.sha256Hex(raw).equals(sha256)) {
            throw new ChangesException(422, "Snapshot checksum mismatch.");
        }
        return new SnapshotResult(raw, filename);
    }

    public static class ChangesException extends RuntimeException {
        private final int status;

        public ChangesException(int status, String message) {
            super(message);
            this.status = status;
        }

        public int getStatus() {
            return status;
        }
    }

    private static byte[] readBounded(InputStream in, int maxBytes) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        int total = 0;
        while ((read = in.read(buffer)) != -1) {
            total += read;
            if (total > maxBytes) {
                throw new IOException("Output exceeded " + maxBytes + " bytes");
            }
            out.write(buffer, 0, read);
        }
        return out.toByteArray();
    }
}
