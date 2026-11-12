package com.truth2power.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.truth2power.config.RepoPaths;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * The grading read views — port of backend/grading/routes.js.
 *
 * <p>The grader itself is deterministic Node (backend/grading/grade.js) and
 * is never ported to Java. {@code backend_2} runs it out-of-process through
 * the bundled {@code grade-wrapper.mjs}, which imports the repo's grade.js
 * and prints the report. The wrapper lives in backend_2's resources, so
 * backend/ stays untouched.
 *
 * <p>Resolution order, like the old route: a committed 2026 pipeline bundle
 * for the hospital wins; otherwise the staged {@code <key>.json} under the
 * grading directory is graded on the fly.
 */
@Service
public class GradingService {

    private static final Logger log = LoggerFactory.getLogger(GradingService.class);

    private final RepoPaths paths;
    private final AuditStore store;

    public GradingService(RepoPaths paths, AuditStore store) {
        this.paths = paths;
        this.store = store;
    }

    /** The grading directory: T2P_GRADING_DIRECTORY or &lt;repo&gt;/.audit/grading. */
    public Path gradingRoot() {
        String env = System.getenv("T2P_GRADING_DIRECTORY");
        if (env != null && !env.isBlank()) {
            return Path.of(env).toAbsolutePath().normalize();
        }
        return paths.auditDir().resolve("grading");
    }

    /** The demo input: docs/grading/examples/SYN-multilingual.json. */
    public Path demoInput() {
        return paths.repoRoot().resolve("docs/grading/examples/SYN-multilingual.json");
    }

    /** Grade one staged input file via the Node wrapper. */
    public ObjectNode gradeFile(Path input, Path root, String decisionsDir)
            throws IOException, InterruptedException {
        Path gradeJs = paths.repoRoot().resolve("backend/grading/grade.js");
        Path wrapper = extractWrapper();
        List<String> command = new java.util.ArrayList<>();
        command.add("node");
        command.add(wrapper.toString());
        command.add(gradeJs.toString());
        command.add(input.toString());
        command.add(root.toString());
        if (decisionsDir != null && !decisionsDir.isBlank()) {
            command.add(decisionsDir);
        }
        ProcessBuilder pb = new ProcessBuilder(command);
        pb.directory(paths.repoRoot().toFile());
        // The Node grader shells out to validate.py with T2P_PYTHON || "python";
        // default to python3 when unset (see AuditWorkerSupervisor).
        pb.environment().putIfAbsent("T2P_PYTHON", "python3");
        pb.redirectErrorStream(true);
        Process p = pb.start();
        String output;
        try (InputStream in = p.getInputStream()) {
            output = new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
        boolean finished = p.waitFor(60, TimeUnit.SECONDS);
        if (!finished) {
            p.destroyForcibly();
            throw new IOException("Grading timed out");
        }
        if (p.exitValue() != 0) {
            log.warn("Node grader failed for {}: {}", input, output.strip());
            throw new IOException("Grading failed");
        }
        JsonNode report = Json.MAPPER.readTree(output);
        if (!report.isObject()) {
            throw new IOException("Grader returned a non-object report");
        }
        return (ObjectNode) report;
    }

    private Path extractWrapper() throws IOException {
        Path tmp = Files.createTempFile("t2p-grade-wrapper-", ".mjs");
        try (InputStream in = getClass().getResourceAsStream("/grading/grade-wrapper.mjs")) {
            if (in == null) {
                throw new IOException("Bundled grade-wrapper.mjs not found");
            }
            Files.write(tmp, in.readAllBytes());
        }
        tmp.toFile().deleteOnExit();
        return tmp;
    }

    /**
     * The grading report for a hospital: the committed 2026 bundle's report
     * (with {@code revision}) when one exists, else the staged input graded
     * on the fly. Throws AuditException(404) when nothing is staged and
     * AuditException(422) on mismatch/validation failure.
     */
    public ObjectNode gradeHospital(String key) {
        try {
            List<ObjectNode> bundles = PipelineViews.pipelineBundles(store.auditDir(), store.pipelineRoot());
            for (ObjectNode b : bundles) {
                if (key.equals(Json.text(b.path("input"), "hospital_key"))
                        && b.path("input").path("guideline_year").asInt(-1) == 2026) {
                    ObjectNode report = (ObjectNode) b.path("report").deepCopy();
                    report.put("revision", Json.text(b, "id"));
                    return report;
                }
            }
        } catch (RuntimeException e) {
            throw AuditException.fail(422,
                    "Saved assessment could not be validated. Run the local grading command for details.");
        }
        Path input = gradingRoot().resolve(key + ".json");
        if (!Files.exists(input)) {
            throw AuditException.fail(404, "Saved assessment or evidence unavailable.");
        }
        JsonNode staged;
        try {
            staged = Json.readFile(input);
        } catch (IOException e) {
            throw AuditException.fail(404, "Saved assessment or evidence unavailable.");
        }
        if (!key.equals(Json.text(staged, "hospital_key"))) {
            throw AuditException.fail(422, "Assessment hospital mismatch.");
        }
        try {
            return gradeFile(input, gradingRoot(), System.getenv("T2P_OBSERVATION_DECISIONS"));
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            throw AuditException.fail(422,
                    "Saved assessment could not be validated. Run the local grading command for details.");
        }
    }

    /** Grade the synthetic multilingual demo input. */
    public ObjectNode gradeDemo() {
        try {
            return gradeFile(demoInput(), demoInput().getParent(), null);
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            throw AuditException.fail(422,
                    "Saved assessment could not be validated. Run the local grading command for details.");
        }
    }
}
